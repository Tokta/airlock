import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { protectedMounts, quarantineCreated, snapshotMissing } from '../src/protect.js';
import { createExclusive, realpathLoose, writeFileAtomic } from '../src/safefs.js';
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
