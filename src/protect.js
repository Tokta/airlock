// Project files that don't stay inside the pod: things that later EXECUTE on the host, or that
// configure the Claude session orchestrating pods from the host. A pod may write the whole project,
// so without this, one hostile run could plant e.g. a git hook that runs on your next `git push`.
//
//   - Existing ones are bind-mounted read-only over the project mount.
//   - `.claude/` and `.git/hooks/` are created empty first when missing, so they can be locked too.
//   - So is the folder `core.hooksPath` names, when it is inside the project (e.g. `.githooks`).
//   - Others can't be pre-created without side effects (an empty .mcp.json breaks Claude), so if a
//     pod creates one it is renamed to `<name>.claude-pod-quarantine-<timestamp>` after the run.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pendingDir } from './paths.js';
import { ensurePrivateDir, isInside, kind, readRegularFile, writeFileAtomic } from './safefs.js';
import { CliError, warn } from './ui.js';

const LOCKED = [
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
export function protectedMounts(root) {
  const gitIsDir = kind(path.join(root, '.git')) === 'dir';
  if (gitIsDir && kind(path.join(root, '.git', 'commondir')) !== 'missing') {
    throw new CliError(`${path.join(root, '.git', 'commondir')} exists, which redirects git's config and hooks. Refusing to start a pod.`, {
      hint: 'A previous pod may have planted it. Inspect it, remove it, and relaunch.',
    });
  }
  const pinned = gitIsDir ? [path.join(root, '.git')] : [];
  const mounts = [];
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
    mounts.push(p);
  }
  if (gitIsDir) {
    const hooks = hooksPath(root);
    if (hooks) lockHooksPath(root, hooks, mounts);
  }
  return { pinned, readOnly: mounts };
}

const refuse = (msg, hint = 'A previous pod may have planted it. Inspect it, remove it, and relaunch.') => {
  throw new CliError(`${msg} Refusing to start a pod.`, { hint });
};

// The folder `core.hooksPath` names, as an absolute path, or null when it isn't set. Read from
// .git/config alone (locked read-only above, so the pod can't have changed it): never plain
// `git config` in the project, which would honour an includeIf or include the pod planted
// elsewhere. --type=path makes git expand `~/` and `%(prefix)/` exactly as it does for its hooks.
function hooksPath(root) {
  const file = path.join(root, '.git', 'config');
  const res = spawnSync('git', ['config', '--file', file, '--no-includes', '--type=path', '--get', 'core.hooksPath'], {
    cwd: '/', encoding: 'utf8',
  });
  if (res.error?.code === 'ENOENT') return null; // no git on the host, so nothing there runs hooks
  if (res.error) throw res.error;
  if (res.status === 1) return null; // not set
  if (res.status !== 0) refuse(`Could not read core.hooksPath from ${file}: ${res.stderr.trim() || `git exited ${res.status}`}.`, 'Fix .git/config (host git fails on it too), and relaunch.');
  const value = res.stdout.replace(/\n$/, '');
  if (!value) return null; // empty: git runs no hooks
  // A relative value is taken from the top of the working tree, which is `root` here (.git is in it).
  return path.resolve(root, value);
}

// Locks the core.hooksPath folder like .git/hooks: read-only, created if missing. Refuses when it
// is outside the project or reached through a symlink (the pod could point it at a host folder),
// or when locking it would lock the whole project or .git.
function lockHooksPath(root, hooks, mounts) {
  const hint = 'core.hooksPath in .git/config points there. Point it at a folder inside the project (e.g. .githooks), or unset it.';
  if (!isInside(hooks, root)) refuse(`core.hooksPath is ${hooks}, outside the project.`, hint);
  if (hooks === root || hooks === path.join(root, '.git')) refuse(`core.hooksPath is ${hooks}; locking it would make the whole ${hooks === root ? 'project' : '.git folder'} read-only.`, hint);
  if (mounts.some((m) => isInside(hooks, m))) return; // already locked (.git/hooks, or inside .claude/…)
  // A folder under a path that is only watched (.vscode, .envrc, …) would create that path, which
  // then counts as yours and is never quarantined.
  const watched = WATCHED.find((rel) => rel !== '.git' && isInside(hooks, path.join(root, rel)));
  if (watched) refuse(`core.hooksPath is ${hooks}, inside ${watched}, which is missing.`, hint);
  // Every existing component must be a real directory: mkdir and realpath would follow a symlink.
  let cur = root;
  for (const part of path.relative(root, hooks).split(path.sep)) {
    cur = path.join(cur, part);
    const k = kind(cur);
    if (k === 'missing') break;
    if (k !== 'dir') refuse(`${cur} is a ${k}, not a dir (core.hooksPath is ${hooks}).`);
  }
  if (kind(hooks) === 'missing') fs.mkdirSync(hooks, { recursive: true });
  const k = kind(hooks);
  if (k !== 'dir' || !isInside(fs.realpathSync(hooks), root)) refuse(`${hooks} is a ${k === 'dir' ? 'path outside the project' : k}, not a dir.`);
  mounts.push(hooks);
}

export function snapshotMissing(root) {
  return WATCHED.filter((rel) => kind(path.join(root, rel)) === 'missing');
}

// After a run: rename protected paths the pod created. rename() moves a symlink itself, never its
// target. Returns the list of quarantined paths.
export function quarantineCreated(root, missingBefore) {
  const moved = [];
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const rel of missingBefore) {
    const p = path.join(root, rel);
    if (kind(p) === 'missing') continue;
    const dest = `${p}.claude-pod-quarantine-${stamp}`;
    try {
      fs.renameSync(p, dest);
      moved.push(dest);
      warn(`The pod created ${rel}, which would run on your host. Quarantined as ${path.basename(dest)} — review it before restoring.`);
    } catch (e) {
      warn(`The pod created ${rel}, which would run on your host, and it could not be quarantined (${e.code}). Review it now.`);
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

export function recordPending(root, name, missing) {
  ensurePrivateDir(pendingDir());
  writeFileAtomic(pendingFile(name), JSON.stringify({ root, name, missing, createdAt: Date.now() }));
}

export function clearPending(name) {
  fs.rmSync(pendingFile(name), { force: true });
}

// Quarantines for one record and deletes it. Used by the watchdog after it stopped the pod.
export function sweepRecord(name) {
  let rec;
  try {
    rec = JSON.parse(readRegularFile(pendingFile(name))?.toString('utf8') || 'null');
  } catch {
    return;
  }
  if (rec && Array.isArray(rec.missing) && typeof rec.root === 'string') quarantineCreated(rec.root, rec.missing.filter((r) => WATCHED.includes(r)));
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
    let rec;
    try {
      rec = JSON.parse(readRegularFile(pendingFile(name)).toString('utf8'));
    } catch {
      continue;
    }
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
