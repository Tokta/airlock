// Project files that don't stay inside the pod: things that later EXECUTE on the host, or that
// configure the Claude session orchestrating pods from the host. A pod may write the whole project,
// so without this, one hostile run could plant e.g. a git hook that runs on your next `git push`.
//
//   - Existing ones are bind-mounted read-only over the project mount.
//   - `.claude/` and `.git/hooks/` are created empty first when missing, so they can be locked too.
//   - So is the folder `core.hooksPath` names, when it is inside the project (e.g. `.githooks`).
//   - The config's `readOnly` paths (scripts the host runs) are locked when they exist, and
//     quarantined like the rest when a pod creates one.
//   - Others can't be pre-created without side effects (an empty .mcp.json breaks Claude), so if a
//     pod creates one it is renamed to `<name>.airlock-quarantine-<timestamp>` after the run.
//   - On a case-insensitive file system (macOS) a read-only *file* mount can still be written
//     through another spelling of its name (`.git/CONFIG`). Those files are copied to host-only
//     state at launch and put back after the run if they changed (see snapshotFiles).
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pendingDir, sha256 } from './paths.js';
import { ensurePrivateDir, isInside, kind, readRegularFile, writeFileAtomic } from './safefs.js';
import { CliError, warn } from './ui.js';

export const LOCKED = [
  { rel: '.git/hooks', type: 'dir', create: true }, // run by git on the host (commit, push, …)
  { rel: '.git/config', type: 'file' }, // core.fsmonitor, core.hooksPath, filters, aliases, sshCommand
  { rel: '.git/config.worktree', type: 'file' }, // read after .git/config when extensions.worktreeConfig is on
  { rel: '.claude', type: 'dir', create: true }, // settings/hooks/agents loaded by host Claude
  { rel: '.mcp.json', type: 'file' }, // MCP servers started by host Claude
  { rel: '.envrc', type: 'file' }, // direnv runs it on `cd`
  { rel: '.vscode', type: 'dir' }, // tasks/settings run by the editor
  { rel: '.idea', type: 'dir' },
];

// Created by a pod where none existed → quarantined after the run. `.git/commondir` makes git read
// its config and hooks from another folder; normal repositories never have one. `.git/config.worktree`
// overrides .git/config (hooksPath, fsmonitor) once `git sparse-checkout` has turned it on.
const WATCHED = ['.mcp.json', '.envrc', '.vscode', '.idea', '.git', '.git/commondir', '.git/config.worktree'];

// Returns { pinned, readOnly } mounts for `root`. `pinned` are read-write self-mounts that make a
// directory a mount point, so the pod can't rename it away and put a fresh one (with its own
// hooks) in its place. Refuses when a protected path is a symlink or resolves outside the project:
// a pod may have planted it to get a host file mounted into the next pod.
// `extra` is the config's `readOnly` list, already checked by readOnlyPath().
export function protectedMounts(root, extra = []) {
  const gitIsDir = kind(path.join(root, '.git')) === 'dir';
  if (gitIsDir && kind(path.join(root, '.git', 'commondir')) !== 'missing') {
    throw new CliError(`${path.join(root, '.git', 'commondir')} exists, which redirects git's config and hooks. Refusing to start a pod.`, {
      hint: 'A previous pod may have planted it. Inspect it, remove it, and relaunch.',
    });
  }
  const pinned = gitIsDir ? [path.join(root, '.git')] : [];
  const mounts = [];
  // A linked worktree or submodule: the `.git` file says where git reads hooks and config.
  if (kind(path.join(root, '.git')) === 'file') {
    singleLink(path.join(root, '.git'));
    mounts.push(canonical(root, path.join(root, '.git')));
  }
  for (const { rel, type, create } of LOCKED) {
    if (rel.startsWith('.git/') && !gitIsDir) continue; // worktree/submodule: the real .git dir isn't mounted
    const p = path.join(root, rel);
    let k = kind(p);
    if (k === 'missing' && create) {
      fs.mkdirSync(p, { recursive: true });
      k = kind(p);
    }
    if (k === 'missing') continue;
    if (k !== type || !isInside(fs.realpathSync(p), root)) {
      throw new CliError(`${p} is a ${k === type ? 'path outside the project' : k}, not a ${type}. Refusing to start a pod.`, {
        hint: 'A previous pod may have planted it. Inspect it, remove it, and relaunch.',
      });
    }
    if (k === 'file') singleLink(p);
    mounts.push(canonical(root, p));
  }
  for (const rel of extra) lockExtra(root, rel, mounts, pinned);
  // After `readOnly`, so a hooksPath or include under a listed folder counts as locked already.
  const repo = findRepo(root);
  if (repo) {
    for (const { path: hooks, repoLevel } of hooksPaths(root, repo, mounts)) {
      // Outside the project, a hooks folder is outside every pod: nothing to lock. It is refused
      // only when this project's own repo config names it (see lockHooksPath); from your global
      // config (~/.git-hooks) or a repo above the project (a monorepo) it is left alone.
      if (!isInside(hooks, root) && !(repoLevel && repo.top === root)) continue;
      lockHooksPath(root, hooks, mounts, pinned, repoLevel);
    }
  }
  // A read-only mount inside another one adds nothing; a pinned folder inside a read-only mount
  // would clash with it (same path) or is already fixed in place by it.
  const readOnly = [...new Set(mounts)].filter((m, _, all) => !all.some((o) => o !== m && isInside(m, o)));
  const pins = [...new Set(pinned)].filter((p) => !readOnly.some((r) => isInside(p, r)));
  return { pinned: pins, readOnly };
}

// `p` under `root` with each part spelled as on disk. macOS and Windows file systems ignore case,
// so `SCRIPTS` and `scripts` are one folder there: without this, two spellings would dodge the
// dedupe below and a pinned read-write mount could land on top of a read-only one.
function canonical(root, p) {
  return path.join(root, path.relative(fs.realpathSync.native(root), fs.realpathSync.native(p)));
}

// Walks `rel` (`a/b/c`) under `root`. Every existing folder above the last part must be a real
// directory: a symlink there would make mkdir, realpath and the mount reach outside the project.
// Returns those folders, which the caller pins, and the kind of the last part ('missing' when any
// part is missing).
function walk(root, rel, why) {
  const parts = rel.split('/');
  const dirs = [];
  let cur = root;
  for (const [i, part] of parts.entries()) {
    cur = path.join(cur, part);
    const k = kind(cur);
    if (k === 'missing') return { dirs, leaf: 'missing' };
    if (i === parts.length - 1) return { dirs, leaf: k };
    if (k !== 'dir') refuse(`${cur} is a ${k}, not a dir (${why}).`);
    dirs.push(canonical(root, cur));
  }
}

// Checks one `readOnly` config entry. Returns { rel } normalized (`a/b`, no `./` or trailing `/`)
// or { error }. The checks are on the text alone, so the watchdog can apply them to a pending
// record too; symlinks are refused at launch by lockExtra.
export function readOnlyPath(p) {
  if (typeof p !== 'string' || !p) return { error: 'must be a non-empty string' };
  // `:` would split docker's -v value; `\\` is a separator on Windows; newlines and NUL can't be
  // passed at all.
  if (/[\0\n\r:\\]/.test(p)) return { error: 'contains a character airlock can\'t mount (`:`, `\\`, newline or NUL)' };
  if (path.isAbsolute(p) || p.startsWith('~')) return { error: 'must be relative to the project' };
  const parts = p.split('/').filter((s) => s && s !== '.');
  if (!parts.length) return { error: 'names the whole project' };
  if (parts.includes('..')) return { error: 'must not contain ".."' };
  // Lower-cased: macOS and Windows file systems ignore case, so `.GIT` is `.git` there.
  const lower = parts.map((s) => s.toLowerCase());
  if (lower.includes('node_modules')) return { error: 'must not be under node_modules' };
  if (lower[0] === '.git') return { error: 'is under .git, which airlock already protects' };
  return { rel: parts.join('/') };
}

// Locks one `readOnly` path that exists: a file or a real directory, reached through real
// directories only, inside the project. The folders above it are pinned: a read-only mount can't
// be renamed, but the folder holding it can, and a fresh one put in its place. A missing path is
// left to snapshotMissing (quarantine), with its existing folders pinned all the same.
function lockExtra(root, rel, mounts, pinned) {
  const p = path.join(root, rel);
  const why = `"readOnly" lists ${rel}`;
  const { dirs, leaf } = walk(root, rel, why);
  pinned.push(...dirs);
  if (leaf === 'missing') return;
  if (leaf !== 'file' && leaf !== 'dir') refuse(`${p} is a ${leaf}, not a file or dir (${why}).`);
  if (!isInside(fs.realpathSync(p), root)) refuse(`${p} resolves outside the project (${why}).`);
  if (leaf === 'file') singleLink(p);
  mounts.push(canonical(root, p));
}

// A file with a second hard link can be changed through the other name, which no mount covers.
function singleLink(p) {
  const n = fs.lstatSync(p).nlink;
  if (n > 1) {
    refuse(`${p} has ${n} hard links, so a pod could change it through another name.`,
      `A previous pod may have made one. Replace it with a plain copy (cp -p "${p}" "${p}.tmp" && mv "${p}.tmp" "${p}"), and relaunch.`);
  }
}

const refuse = (msg, hint = 'A previous pod may have planted it. Inspect it, remove it, and relaunch.') => {
  throw new CliError(`${msg} Refusing to start a pod.`, { hint });
};

// Where host git keeps this project's settings: the nearest `.git` at or above `root` (above it
// in a monorepo). `top` is the folder holding that `.git`; `gitDir` the git dir; `commonDir` where
// `config` lives (the main repo's, for a linked worktree). null when there is none.
function findRepo(root) {
  for (let dir = root; ; dir = path.dirname(dir)) {
    const dotGit = path.join(dir, '.git');
    const k = kind(dotGit);
    if (k === 'dir') return { top: dir, gitDir: dotGit, commonDir: dotGit };
    if (k === 'file') {
      // A linked worktree or submodule: `gitdir: <path>`. At the project root this file is mounted
      // read-only, so the pod can't repoint it; what it points at must be outside the project.
      const m = /^gitdir: (.+)$/m.exec(readRegularFile(dotGit, 64 * 1024).toString('utf8'));
      if (!m) return null; // git refuses this repo too
      const gitDir = path.resolve(dir, m[1].trim());
      if (isInside(nativeLoose(gitDir), nativeLoose(root))) refuse(`${dotGit} points git at ${gitDir}, inside the project, where a pod could write its hooks and config.`, 'Keep the git dir outside the project, and relaunch.');
      let commonDir = gitDir;
      const cd = path.join(gitDir, 'commondir');
      if (kind(cd) === 'file') commonDir = path.resolve(gitDir, readRegularFile(cd, 64 * 1024).toString('utf8').trim());
      return { top: dir, gitDir, commonDir };
    }
    if (k !== 'missing') return null;
    if (path.dirname(dir) === dir) return null;
  }
}

// `p` resolved like realpathLoose (safefs.js), but with each existing part spelled as on disk, so a path in
// another case (or Unicode form) compares equal on macOS.
function nativeLoose(p) {
  const tail = [];
  let cur = path.resolve(p);
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...tail.reverse());
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

// Runs `git config --file <file> -z <args>` without includes and returns its values, [] when the
// key is unset, or null when the host has no git (then nothing there runs hooks). Never plain
// `git config` in the project: that would honour an include the pod planted.
function gitConfig(file, args, what) {
  const res = spawnSync('git', ['config', '--file', file, '--no-includes', '-z', ...args], { cwd: '/', encoding: 'utf8' });
  if (res.error?.code === 'ENOENT') return null;
  if (res.error) throw res.error;
  if (res.status === 1) return [];
  if (res.status !== 0) refuse(`Could not read ${what} from ${file}: ${res.stderr.trim() || `git exited ${res.status}`}.`, `Fix ${file} (host git fails on it too), and relaunch.`);
  return res.stdout.split('\0').slice(0, -1);
}

// Your global and system git config files, which host git reads in this project too, found the
// way git finds them (GIT_CONFIG_GLOBAL, GIT_CONFIG_SYSTEM, GIT_CONFIG_NOSYSTEM).
function hostGitConfigs() {
  const home = os.homedir();
  const files = process.env.GIT_CONFIG_GLOBAL
    ? [path.resolve(process.env.GIT_CONFIG_GLOBAL)]
    : [path.join(home, '.gitconfig'), path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'git', 'config')];
  if (/^(1|true|yes|on)$/i.test(process.env.GIT_CONFIG_NOSYSTEM || '')) return files;
  // Asked of git, which knows its build's path and honours GIT_CONFIG_SYSTEM.
  const res = spawnSync('git', ['config', '--system', '--show-origin', '--list', '-z'], { cwd: '/', encoding: 'utf8' });
  const m = res.status === 0 ? /^file:([^\0]+)\0/.exec(res.stdout) : null;
  if (m) files.push(m[1]);
  return files;
}

// Every folder `core.hooksPath` may name for host git: { path, repoLevel }. Read from the repo's
// config and config.worktree, your global and system config, and every file they include,
// following includes ourselves. Every value counts, not only the one git would pick: an
// `[includeIf]` may or may not apply, and locking one folder too many is harmless. Refuses an
// include that points into the project, outside the read-only mounts: the pod could write
// hooksPath, fsmonitor or anything else there. --type=path expands `~/` as git does.
function hooksPaths(root, repo, mounts) {
  // Compared both as written (a symlink in the project that points out is still the pod's to
  // repoint) and resolved; folded on macOS, where `../MyApp` and `../myapp` are one folder.
  const fold = process.platform === 'darwin' ? (x) => x.normalize('NFC').toLowerCase() : (x) => x;
  const roots = [root, nativeLoose(root)].map(fold);
  const locked = mounts.flatMap((m) => [m, nativeLoose(m)]).map(fold);
  const inProject = (t) => [t, nativeLoose(t)].map(fold).some((x) => roots.some((r) => isInside(x, r)) && !locked.some((m) => isInside(x, m)));
  const values = [];
  const seen = new Set();
  const visit = (file, depth, repoLevel) => {
    if (seen.has(file) || depth > 10 || kind(file) === 'missing') return; // git skips a missing include
    seen.add(file);
    const hooks = gitConfig(file, ['--type=path', '--get-all', 'core.hooksPath'], 'core.hooksPath');
    if (hooks === null) return;
    // A relative value is taken from the top of the working tree.
    for (const v of hooks) if (v) values.push({ path: path.resolve(repo.top, v), repoLevel });
    // -z prints `key\nvalue` per entry; a bare `path` key (no value) has no newline.
    for (const entry of gitConfig(file, ['--type=path', '--get-regexp', '^include(if\\..*)?\\.path$'], 'includes')) {
      const nl = entry.indexOf('\n');
      if (nl < 0 || nl === entry.length - 1) continue;
      const target = path.resolve(path.dirname(file), entry.slice(nl + 1)); // relative to the including file
      if (inProject(target)) {
        refuse(`${file} includes ${target}, which is inside the project, so a pod could write git settings there.`,
          'Move that file out of the project (or into a "readOnly" folder), or drop the include, and relaunch.');
      }
      visit(target, depth + 1, repoLevel);
    }
  };
  visit(path.join(repo.commonDir, 'config'), 0, true);
  visit(path.join(repo.gitDir, 'config.worktree'), 0, true);
  for (const file of hostGitConfigs()) visit(file, 0, false);
  const out = [];
  for (const v of values) if (!out.some((o) => o.path === v.path)) out.push(v);
  return out;
}

// Locks the core.hooksPath folder like .git/hooks: read-only, created if missing. Refuses when it
// is outside the project or reached through a symlink (the pod could point it at a host folder),
// or when locking it would lock the whole project or .git.
function lockHooksPath(root, hooks, mounts, pinned, repoLevel = true) {
  const hint = 'core.hooksPath in .git/config points there. Point it at a folder inside the project (e.g. .githooks), or unset it.';
  if (!isInside(hooks, root)) refuse(`core.hooksPath is ${hooks}, outside the project.`, hint);
  if (hooks === root || hooks === path.join(root, '.git')) refuse(`core.hooksPath is ${hooks}; locking it would make the whole ${hooks === root ? 'project' : '.git folder'} read-only.`, hint);
  if (mounts.some((m) => isInside(hooks, m))) return; // already locked (.git/hooks, or inside .claude/…)
  // A folder under a path that is only watched (.vscode, .envrc, …) would create that path, which
  // then counts as yours and is never quarantined.
  const watched = WATCHED.find((rel) => rel !== '.git' && isInside(hooks, path.join(root, rel)));
  // From your global config it applies to every project: there a missing watched folder is
  // simply quarantined whole if a pod creates it.
  if (watched && !repoLevel) return;
  if (watched) refuse(`core.hooksPath is ${hooks}, inside ${watched}, which is missing.`, hint);
  // Checked before mkdir, which would follow a symlink; walked again after it, so folders it
  // created are pinned too (see lockExtra).
  const rel = path.relative(root, hooks).split(path.sep).join('/');
  const why = `core.hooksPath is ${hooks}`;
  if (walk(root, rel, why).leaf === 'missing') fs.mkdirSync(hooks, { recursive: true });
  const { dirs, leaf: k } = walk(root, rel, why);
  if (k !== 'dir' || !isInside(fs.realpathSync(hooks), root)) refuse(`${hooks} is a ${k === 'dir' ? 'path outside the project' : k}, not a dir.`);
  pinned.push(...dirs);
  mounts.push(canonical(root, hooks));
}

// The protected paths missing right now. For a `readOnly` entry under a missing folder
// (`infra/prod.sh` with no `infra/`), that folder is recorded, so quarantine renames what the pod
// created at the top instead of reaching through it. Entries inside `readOnly` mounts are left
// out: the pod can't create them, so whatever appears there during a run is yours.
export function snapshotMissing(root, extra = [], readOnly = []) {
  // With `.git` a file (worktree, submodule), nothing can be created under it: skip `.git/…`.
  const gitIsFile = !['dir', 'missing'].includes(kind(path.join(root, '.git')));
  const missing = WATCHED.filter((rel) => !(gitIsFile && rel.startsWith('.git/')) && kind(path.join(root, rel)) === 'missing');
  for (const rel of extra) {
    if (readOnly.some((m) => isInside(path.join(root, rel), m))) continue;
    const parts = rel.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join('/');
      if (kind(path.join(root, prefix)) !== 'missing') continue;
      if (!missing.includes(prefix)) missing.push(prefix);
      break;
    }
  }
  return missing;
}

// The first folder above `rel` that is a symlink (or other non-file the pod put there), as a
// relative path, or null. Renaming `rel` through it could move a file elsewhere. A plain file on
// the way needs nothing: `rel` then reads as missing and nothing is renamed.
function plantedParent(root, rel) {
  const parts = rel.split('/');
  for (let i = 1; i < parts.length; i++) {
    const k = kind(path.join(root, ...parts.slice(0, i)));
    if (k === 'missing' || k === 'file') return null;
    if (k !== 'dir') return parts.slice(0, i).join('/');
  }
  return null;
}

// `<p>.airlock-quarantine-<timestamp>-<random>`. The random part means a pod can't put
// something at that name in advance to make the rename fail.
const quarantineName = (p, stamp) => `${p}.airlock-quarantine-${stamp}-${crypto.randomBytes(4).toString('hex')}`;

// After a run: rename protected paths the pod created. rename() moves a symlink itself, never its
// target. `extra` is the config's `readOnly` list, to name the entry a missing folder was recorded
// for. Returns the list of quarantined paths.
export function quarantineCreated(root, missingBefore, extra = []) {
  const moved = [];
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const entry of missingBefore) {
    // When a folder on the way was swapped for a symlink, that symlink is what gets renamed.
    const rel = plantedParent(root, entry) || entry;
    const p = path.join(root, rel);
    if (kind(p) === 'missing') continue;
    const under = WATCHED.includes(entry) || extra.includes(entry) ? null : extra.find((r) => r.startsWith(`${entry}/`));
    const name = under ? `${entry}/ (which holds ${under}, listed in "readOnly")` : entry;
    const what = rel === entry ? name : `${rel} (in place of a folder, on the way to ${name})`;
    const dest = quarantineName(p, stamp);
    try {
      fs.renameSync(p, dest);
      moved.push(dest);
      warn(`The pod created ${what}, which would run on your host. Quarantined as ${path.basename(dest)} — review it before restoring.`);
    } catch (e) {
      warn(`The pod created ${what}, which would run on your host, and it could not be quarantined (${e.code}). Review it now.`);
    }
  }
  return moved;
}

// ── Crash-safe quarantine ─────────────────────────────────────────────────────────────────────
// The launcher quarantines when its pod exits. If the launcher itself dies first (kill -9, crash,
// power loss), that step never runs — so each run also records what was missing at its start in
// host-only state. The watchdog, and every later launch in the same project, sweep records whose
// pod is no longer running, before anything could treat a pod-made file as the user's.

const pendingFile = (name) => path.join(pendingDir(), `${name}.json`);
const backupDir = (name) => path.join(pendingDir(), `${name}.files`);

// `files` comes from snapshotFiles (written first, so its backups are in place), `extra` is the
// config's `readOnly` list, `locked` the files this run made immutable (see beginRun).
export function recordPending(root, name, missing, { files = [], extra = [], locked = [] } = {}) {
  ensurePrivateDir(pendingDir());
  writeFileAtomic(pendingFile(name), JSON.stringify({ root, name, missing, files, readOnly: extra, locked, createdAt: Date.now() }));
}

export function clearPending(name) {
  fs.rmSync(pendingFile(name), { force: true });
  fs.rmSync(backupDir(name), { recursive: true, force: true });
}

function readRecord(name) {
  try {
    return JSON.parse(readRegularFile(pendingFile(name))?.toString('utf8') || 'null');
  } catch {
    return null;
  }
}

// The records of this project's other runs that haven't been swept: their pods may be running.
function otherRecords(root, self) {
  let names;
  try {
    names = fs.readdirSync(pendingDir()).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  } catch {
    return [];
  }
  return names.filter((n) => n !== self).map(readRecord).filter((r) => r?.root === root)
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

// Whether `p` (a real path inside `root`) is, or is inside, a path that some run of this project
// found missing at its start: that run's pod may have created it, and it is quarantined only once
// the run ends. Until then it is pod-written, whatever the config says.
export function maybePlanted(root, p) {
  const rel = fold(path.relative(root, p).split(path.sep).join('/'));
  return otherRecords(root, null).some((r) => Array.isArray(r.missing) && r.missing.some((m) => (
    typeof m === 'string' && (rel === fold(m) || rel.startsWith(`${fold(m)}/`)))));
}

// The `readOnly` lists of this project's runs that haven't been swept. A pod started under an
// older config may write a path that the current config lists, until that run ends.
export function runningReadOnly(root) {
  return otherRecords(root, null).map((r) => (Array.isArray(r.readOnly) ? r.readOnly.filter((x) => typeof x === 'string') : []));
}

// Serializes the steps that read other runs' records and lock or unlock files, so a run that
// starts while another ends never loses a lock. A mkdir lock: atomic, and host-only.
function withLock(fn) {
  ensurePrivateDir(pendingDir());
  const lock = path.join(pendingDir(), 'lock');
  for (let i = 0; ; i++) {
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Left by a launcher that died holding it: no step takes this long. Renamed away first, so
      // of two waiters that both found it stale only one takes it over.
      try {
        if (Date.now() - fs.lstatSync(lock).mtimeMs > 30_000) {
          const stale = `${lock}.stale-${crypto.randomBytes(4).toString('hex')}`;
          fs.renameSync(lock, stale);
          fs.rmdirSync(stale);
        }
      } catch {
        // gone already, or another waiter took it
      }
      if (i > 400) throw new CliError(`${lock} is held by another airlock run.`, { hint: 'If no airlock is starting or stopping, remove that folder.' });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

// macOS file flags. `uchg` (user immutable) makes a file refuse writes, renames, deletes and new
// hard links from everyone, the pod's Docker Desktop file sharing included, until it is cleared.
// Swappable for tests (setFileFlags), so they never leave undeletable files behind.
const macFlags = {
  supported: process.platform === 'darwin',
  locked: (p) => {
    const res = spawnSync('/usr/bin/stat', ['-f', '%Xf', p], { encoding: 'utf8' }); // lstat: never follows
    return res.status === 0 && (parseInt(res.stdout.trim(), 16) & 0x2) !== 0;
  },
  lock: (p) => spawnSync('/usr/bin/chflags', ['-h', 'uchg', p], { stdio: 'ignore' }).status === 0,
  unlock: (p) => spawnSync('/usr/bin/chflags', ['-h', 'nouchg', p], { stdio: 'ignore' }).status === 0,
};
let flags = macFlags;
export function setFileFlags(impl) {
  const prev = flags;
  flags = impl || macFlags;
  return prev;
}

const fold = (x) => (process.platform === 'darwin' ? x.normalize('NFC').toLowerCase() : x);

// Before a pod starts: records what is missing and copies the read-only files whose names have
// other spellings (snapshotFiles), then makes those files immutable for the run. A file is locked
// once for all pods of the project: the first run locks it, the last one to end unlocks it. A file
// you made immutable yourself is left as it is. Paths another running pod found missing are its
// to quarantine: this run treats them as missing too, never as yours.
// Returns the record.
export function beginRun(root, name, { missing, readOnly, extra }) {
  return withLock(() => {
    const others = otherRecords(root, name);
    const theirMissing = others.flatMap((r) => (Array.isArray(r.missing) ? r.missing : [])).filter((r) => typeof r === 'string');
    const all = [...missing];
    for (const rel of theirMissing) if (!all.includes(rel) && kind(path.join(root, rel)) !== 'missing') all.push(rel);
    const planted = (p) => all.some((rel) => { const r = fold(path.relative(root, p).split(path.sep).join('/')); return r === fold(rel) || r.startsWith(`${fold(rel)}/`); });
    const files = snapshotFiles(root, readOnly.filter((p) => !planted(p)), name);
    const theirs = new Set(others.flatMap((r) => (Array.isArray(r.locked) ? r.locked : [])));
    const locked = flags.supported ? files.map((f) => f.path).filter((p) => theirs.has(p) || !flags.locked(p)) : [];
    // Recorded first: if this launcher dies half-way, the sweep still unlocks what it locked.
    recordPending(root, name, all, { files, extra, locked });
    const done = [];
    for (const p of locked) {
      // Checked on the file, not on the other record's word: you may have unlocked it since.
      if (flags.locked(p)) continue;
      if (flags.lock(p)) {
        done.push(p);
        continue;
      }
      for (const q of done) flags.unlock(q);
      clearPending(name);
      refuse(`Could not make ${p} immutable for the run (chflags uchg).`, 'On macOS a pod could otherwise change it through another spelling of its name. Check you own it, and relaunch.');
    }
    return { root, name, missing: all, files, locked };
  });
}

// After a run (or for a launcher that died): unlocks what no other running pod holds, quarantines
// what the pod created, puts back read-only files that changed, and deletes the record. The
// watchdog calls it after it stopped the pod; never call it while the container may still run.
export function sweepRecord(name) {
  const rec = readRecord(name);
  if (rec && typeof rec.root === 'string') {
    const locked = Array.isArray(rec.locked) ? rec.locked.filter((p) => typeof p === 'string' && isInside(p, rec.root) && p !== rec.root) : [];
    if (locked.length) {
      withLock(() => {
        const theirs = new Set(otherRecords(rec.root, name).flatMap((r) => (Array.isArray(r.locked) ? r.locked : [])));
        for (const p of locked) {
          if (theirs.has(p)) continue;
          if (!flags.unlock(p) && kind(p) !== 'missing') warn(`Could not unlock ${p}. Run: chflags nouchg "${p}"`);
        }
        // No longer holding them: a run that starts now must lock them itself.
        writeFileAtomic(pendingFile(name), JSON.stringify({ ...rec, locked: [] }));
      });
    }
    const extra = Array.isArray(rec.readOnly) ? rec.readOnly.filter((r) => readOnlyPath(r).rel === r) : [];
    if (Array.isArray(rec.missing)) quarantineCreated(rec.root, rec.missing.filter((r) => WATCHED.includes(r) || readOnlyPath(r).rel === r), extra);
    if (Array.isArray(rec.files)) restoreChanged(rec.root, rec.files);
  }
  clearPending(name);
}

// A record younger than this is never swept by another launch: its launcher may still be starting
// the container, which `docker ps` can't see yet.
const GRACE_MS = 2 * 60_000;

// Records whose container is gone and whose launcher had time to start it: left by a launcher
// (and watchdog) that died. `exists(name)` must return true when unsure.
export function listOrphans(exists, root = null) {
  let names;
  try {
    names = fs.readdirSync(pendingDir()).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  } catch {
    return [];
  }
  const orphans = [];
  for (const name of names) {
    const rec = readRecord(name);
    if (!rec) continue;
    if (root !== null && rec?.root !== root) continue;
    if (!(Date.now() - (rec?.createdAt || 0) > GRACE_MS) || exists(name)) continue;
    orphans.push(rec);
  }
  return orphans;
}

// Sweeps this project's orphaned records (see listOrphans).
export function sweepPending(root, exists) {
  for (const rec of listOrphans(exists, root)) sweepRecord(rec.name);
}

// ── Read-only files on a case-insensitive file system ─────────────────────────────────────────
// Linux gives a directory one dentry, so `.CLAUDE/x` lands on the `.claude` mount and fails. A file
// can have several, so `.git/CONFIG` is a fresh dentry next to the mounted `.git/config`, and
// Docker Desktop writes it straight to the host file. No mount can cover every spelling (APFS also
// folds `ſ` to `s`, and Unicode normalization). So on macOS these files are made immutable for the
// run (beginRun). As a second line, they are also copied at launch to host-only state, compared
// after the run, and put back if they changed anyway.

const MAX_GUARDED = 64 * 1024 * 1024;

// Whether another spelling of `p`'s name reaches the same file: a case-insensitive (or, on macOS,
// normalization-insensitive) file system. On a case-sensitive one the mount is enough, and a
// check would only undo your own edits on the host during the run.
export function nameAliased(p) {
  const base = path.basename(p);
  if (process.platform === 'darwin' && /[^\x00-\x7f]/.test(base)) return true;
  const swapped = [...base].map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join('');
  if (swapped === base) return false;
  try {
    const a = fs.lstatSync(p);
    const b = fs.lstatSync(path.join(path.dirname(p), swapped));
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}

// What a file is now, read without following a symlink: { kind, nlink, mode, size, sha256, content }.
function fileState(p) {
  const k = kind(p);
  if (k !== 'file') return { kind: k };
  let fd;
  try {
    fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (e) {
    if (e.code === 'ENOENT') return { kind: 'missing' };
    if (e.code === 'ELOOP') return { kind: 'symlink' };
    throw e;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { kind: 'other' };
    if (st.size > MAX_GUARDED) return { kind: 'file', nlink: st.nlink, mode: st.mode & 0o7777, size: st.size, sha256: null };
    const content = fs.readFileSync(fd);
    return { kind: 'file', nlink: st.nlink, mode: st.mode & 0o7777, size: content.length, sha256: sha256(content), content };
  } finally {
    fs.closeSync(fd);
  }
}

// The launch-time copy of `p` that a still-running pod of this project took, if any. A second pod
// started while the first is changing a file must not take the changed version as the original.
function siblingBackup(root, p, name) {
  for (const rec of otherRecords(root, name).filter((r) => Array.isArray(r.files))) {
    const f = rec.files.find((x) => x?.path === p);
    if (!f || typeof f.backup !== 'string' || !isInside(f.backup, pendingDir())) continue;
    let content;
    try {
      content = readRegularFile(f.backup, MAX_GUARDED);
    } catch {
      continue;
    }
    if (content && sha256(content) === f.sha256) return { content, mode: f.mode };
  }
  return null;
}

// Copies each file-type read-only mount whose name has other spellings into host-only state for
// pod `name`. Returns the entries for the pending record. `aliased` is swappable for tests.
export function snapshotFiles(root, readOnly, name, aliased = nameAliased) {
  const files = [];
  for (const p of readOnly) {
    if (kind(p) !== 'file' || !aliased(p)) continue;
    const now = fileState(p);
    if (now.kind !== 'file') continue; // changed since protectedMounts; it refused anything planted
    if (now.sha256 === null) {
      files.push({ path: p, sha256: null, size: now.size, mode: now.mode, backup: null }); // too large to copy: locked only
      continue;
    }
    const base = siblingBackup(root, p, name) || { content: now.content, mode: now.mode };
    ensurePrivateDir(pendingDir());
    ensurePrivateDir(backupDir(name));
    const backup = path.join(backupDir(name), String(files.length));
    writeFileAtomic(backup, base.content);
    files.push({ path: p, sha256: sha256(base.content), size: base.content.length, mode: base.mode, backup });
  }
  return files;
}

// After a run: puts back each snapshotted file that is no longer the same regular file content
// with one link and the same mode. What the pod left is renamed to a quarantine name, not deleted:
// a change you made yourself on the host during the run looks the same. Returns the restored paths.
export function restoreChanged(root, files) {
  const restored = [];
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const f of files) {
    if (typeof f?.path !== 'string' || typeof f.backup !== 'string' || !isInside(f.path, root) || f.path === root || !isInside(f.backup, pendingDir())) continue;
    const now = fileState(f.path);
    if (now.kind === 'file' && now.nlink === 1 && now.sha256 === f.sha256 && now.mode === f.mode) continue;
    const rel = path.relative(root, f.path);
    const dir = path.dirname(f.path);
    let content;
    try {
      content = readRegularFile(f.backup, MAX_GUARDED);
    } catch {
      content = null;
    }
    // The folders above are pinned, so they should still be real; never write through a swapped one.
    if (!content || sha256(content) !== f.sha256 || kind(dir) !== 'dir' || fs.realpathSync(dir) !== dir) {
      warn(`${rel} changed during the run and could not be put back. Review it now.`);
      continue;
    }
    let kept = '';
    try {
      if (now.kind !== 'missing') {
        // If this fails, writeFileAtomic still renames the copy over what is there.
        const dest = quarantineName(f.path, stamp);
        try {
          fs.renameSync(f.path, dest);
          kept = ` The changed one is kept as ${path.basename(dest)}; if you changed it yourself on the host during the run, review it and restore it.`;
        } catch {
          // a folder in its place: writeFileAtomic fails below and says so
        }
      }
      writeFileAtomic(f.path, content, f.mode);
      restored.push(f.path);
      warn(`${rel} changed during the run (on this file system a pod can write it through another spelling of its name, like ${path.join(path.dirname(rel), path.basename(rel).toUpperCase())}). Put back the version from launch.${kept}`);
    } catch (e) {
      warn(`${rel} changed during the run and could not be put back (${e.code}). Review it now.`);
    }
  }
  return restored;
}
