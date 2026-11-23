import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  assertSafeRoot, findProjectRoot, forgetShims, interpolate, isTrusted, loadConfig, optedIntoShims, shimsOffWarning, trust,
} from '../src/config.js';
import { parseDotenv } from '../src/dotenv.js';
import { readRegularFile } from '../src/safefs.js';
import { tmp } from './helpers.js';

test('project root: config file beats git root, git root beats cwd', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'repo/.git'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'repo/app/src'), { recursive: true });
  assert.equal(findProjectRoot(path.join(dir, 'repo/app/src')).root, path.join(dir, 'repo'));

  fs.writeFileSync(path.join(dir, 'repo/app/claude-pod.config.json'), '{}');
  const found = findProjectRoot(path.join(dir, 'repo/app/src'));
  assert.equal(found.root, path.join(dir, 'repo/app'));
  assert.equal(found.configPath, path.join(dir, 'repo/app/claude-pod.config.json'));
});

test('refuses to mount home, /, ancestors of home, home-like and non-project folders', () => {
  assert.throws(() => assertSafeRoot(os.homedir()), /home directory/);
  assert.throws(() => assertSafeRoot('/'), /filesystem root/);
  assert.throws(() => assertSafeRoot(path.dirname(os.homedir())), /contains your home|filesystem root/);

  const dir = tmp();
  assert.throws(() => assertSafeRoot(dir), /not a git repository/);
  assert.doesNotThrow(() => assertSafeRoot(dir, { requireProject: false }));
  fs.mkdirSync(path.join(dir, '.git'));
  assert.doesNotThrow(() => assertSafeRoot(dir));
  fs.mkdirSync(path.join(dir, '.ssh'));
  assert.throws(() => assertSafeRoot(dir), /looks like a home directory/);
});

test('dotenv: quotes, comments, export, first definition wins', () => {
  const vars = parseDotenv(['# c', 'A=plain # trailing', 'export B="q # not"', "C='s'", 'A=second', 'EMPTY=', 'junk'].join('\n'));
  assert.deepEqual(vars, { A: 'plain', B: 'q # not', C: 's', EMPTY: '' });
});

test('interpolate: envFile vars only, $$ escape, no newlines', () => {
  assert.equal(interpolate('u:${PW}@h $$HOME', { PW: 'x' }, 'env.X'), 'u:x@h $HOME');
  assert.throws(() => interpolate('${HOME}', {}, 'env.X'), /not set in the envFile/); // host env is never consulted
  assert.throws(() => interpolate('${toString}', {}, 'env.X'), /not set/); // no prototype lookups
  assert.throws(() => interpolate('${A}', { A: 'a\nb' }, 'env.X'), /newline/);
});

test('loadConfig resolves env from envFile and validates', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, '.git'));
  const configPath = path.join(dir, 'claude-pod.config.json');
  fs.writeFileSync(path.join(dir, '.env'), 'PW=secret\n');
  fs.writeFileSync(configPath, JSON.stringify({
    $comment: 'x', network: 'app_default', ports: [3000, 3131], envFile: '.env',
    env: { DATABASE_URL: 'postgresql://u:${PW}@postgres/db' }, resources: { memory: '4g', cpus: 2, pids: 512 },
  }));
  const config = loadConfig({ root: dir, configPath });
  assert.equal(config.network, 'app_default');
  assert.deepEqual(config.env, { DATABASE_URL: 'postgresql://u:secret@postgres/db' });
  assert.match(config.hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(config.readOnly, []);
  assert.deepEqual(config.secrets, []);
  assert.equal(config.shims, null);
  fs.writeFileSync(configPath, JSON.stringify({ shims: {} }));
  assert.deepEqual(loadConfig({ root: dir, configPath }).shims, { host: [] });
  fs.writeFileSync(configPath, JSON.stringify({ shims: { host: ['dev', 'deploy:prod'] } }));
  assert.deepEqual(loadConfig({ root: dir, configPath }).shims, { host: ['dev', 'deploy:prod'] });
  fs.writeFileSync(configPath, JSON.stringify({ secrets: ['ANTHROPIC_API_KEY', 'RESEND_API_KEY'] }));
  assert.deepEqual(loadConfig({ root: dir, configPath }).secrets, ['ANTHROPIC_API_KEY', 'RESEND_API_KEY'], 'ANTHROPIC_* allowed: secrets never reach Claude');
  assert.deepEqual(config.ports, [{ port: 3000, fixed: false }, { port: 3131, fixed: false }]);
  fs.writeFileSync(configPath, JSON.stringify({ ports: [{ port: 3000, fixed: true }, 3131, { port: 8080 }, { port: 9000, fixed: false }] }));
  assert.deepEqual(loadConfig({ root: dir, configPath }).ports, [
    { port: 3000, fixed: true }, { port: 3131, fixed: false }, { port: 8080, fixed: false }, { port: 9000, fixed: false },
  ]);
  fs.writeFileSync(configPath, JSON.stringify({ readOnly: ['./scripts/', 'package.json', 'infra//prod'] }));
  assert.deepEqual(loadConfig({ root: dir, configPath }).readOnly, ['scripts', 'package.json', 'infra/prod']);

  const bad = (obj, re) => {
    fs.writeFileSync(configPath, JSON.stringify(obj));
    assert.throws(() => loadConfig({ root: dir, configPath }), re);
  };
  bad({ port: [1] }, /unknown key "port"/);
  bad({ network: 'host' }, /bridge network/);
  bad({ network: 'container:db' }, /bridge network/);
  bad({ ports: [0] }, /not a port number/);
  bad({ ports: [80, 80] }, /80 twice/);
  bad({ ports: [80, { port: 80, fixed: true }] }, /80 twice/);
  bad({ ports: [{ port: 3000, fixed: 'yes' }] }, /"fixed" that is not true or false/);
  bad({ ports: [{ port: 0, fixed: true }] }, /needs "port"/);
  bad({ ports: [{ fixed: true }] }, /needs "port"/);
  bad({ ports: [{ port: 3000, host: 80 }] }, /unknown key "host"/);
  bad({ ports: ['3000'] }, /must be a port number or/);
  bad({ ports: [null] }, /must be a port number or/);
  bad({ ports: 3000 }, /must be an array/);
  bad({ env: { 'A-B': 'x' } }, /not a valid variable name/);
  bad({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'x' } }, /reserved/);
  bad({ env: { HOME: 'x' } }, /reserved/);
  bad({ envFile: '/etc/passwd' }, /relative to the project/);
  bad({ envFile: '../outside.env' }, /not found|outside the project/);
  bad({ resources: { memory: '0' } }, /memory/);
  bad({ resources: { cpus: '-1' } }, /cpus/);
  bad({ resources: { pids: 1 } }, /pids/);
  bad({ shims: [] }, /"shims" must be an object/);
  bad({ shims: { hosts: [] } }, /unknown "shims" key "hosts"/);
  bad({ shims: { host: 'dev' } }, /"shims.host" must be an array/);
  bad({ shims: { host: ['dev', ''] } }, /is not a script name/);
  bad({ shims: { host: ['--filter'] } }, /is not a script name/);
  bad({ shims: { host: ['a b'] } }, /is not a script name/);
  bad({ secrets: 'A' }, /"secrets" must be an array/);
  bad({ secrets: ['A-B'] }, /not a valid variable name/);
  bad({ secrets: ['CLAUDE_CODE_OAUTH_TOKEN'] }, /set by claude-pod itself/);
  bad({ secrets: ['GIT_CONFIG_GLOBAL'] }, /set by claude-pod itself/);
  bad({ secrets: ['A', 'A'] }, /duplicates/);
  bad({ secrets: ['A'], env: { A: 'x' } }, /both "env" and "secrets"/);
  bad({ readOnly: 'scripts' }, /"readOnly" must be an array/);
  bad({ readOnly: [3] }, /non-empty string/);
  bad({ readOnly: ['/etc'] }, /relative to the project/);
  bad({ readOnly: ['~/bin'] }, /relative to the project/);
  bad({ readOnly: ['scripts/../..'] }, /must not contain "\.\."/);
  bad({ readOnly: ['.', './'] }, /whole project/);
  bad({ readOnly: ['node_modules/.bin'] }, /node_modules/);
  bad({ readOnly: ['.git/hooks'] }, /under \.git/);
  bad({ readOnly: ['a:b'] }, /can't mount/);
  bad({ readOnly: ['scripts', './scripts/'] }, /scripts twice/);

  fs.writeFileSync(path.join(path.dirname(dir), 'outside.env'), 'A=1\n');
  fs.symlinkSync(path.join(path.dirname(dir), 'outside.env'), path.join(dir, 'link.env'));
  bad({ envFile: 'link.env' }, /resolves outside the project/);

  fs.rmSync(configPath);
  fs.symlinkSync(path.join(dir, '.env'), configPath);
  assert.throws(() => loadConfig({ root: dir, configPath }), /symlink/);
});

test('trust records are per project and per exact content', () => {
  const prev = process.env.HOME;
  process.env.HOME = tmp();
  try {
    const a = tmp();
    assert.equal(isTrusted(a, 'h1'), false);
    trust(a, 'h1');
    assert.equal(isTrusted(a, 'h1'), true);
    assert.equal(isTrusted(a, 'h2'), false);
    assert.equal(isTrusted(tmp(), 'h1'), false);
  } finally {
    process.env.HOME = prev;
  }
});

test('project root is spelled as on disk, so another case is the same project', (t) => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'MyApp', '.git'), { recursive: true });
  if (!fs.existsSync(path.join(dir, 'myapp'))) return t.skip('case-sensitive file system');
  assert.equal(findProjectRoot(path.join(dir, 'myapp')).root, path.join(dir, 'MyApp'));
});

test('readRegularFile: regular files only, size-capped, read from the opened descriptor', () => {
  const dir = tmp();
  const f = path.join(dir, 'a');
  fs.writeFileSync(f, 'hello');
  assert.equal(readRegularFile(f).toString(), 'hello');
  assert.equal(readRegularFile(path.join(dir, 'none')), null);
  assert.throws(() => readRegularFile(f, 4), /too large/);
  fs.symlinkSync(f, path.join(dir, 'link'));
  assert.throws(() => readRegularFile(path.join(dir, 'link')), /symlink/);
  if (spawnSync('mkfifo', [path.join(dir, 'fifo')]).status === 0) {
    assert.throws(() => readRegularFile(path.join(dir, 'fifo')), /not a regular file/); // never blocks
  }
});

test('shims opt-in: sticky in the trust record, a warning before approving a config that drops it', () => {
  const prev = process.env.HOME;
  process.env.HOME = tmp();
  try {
    const root = tmp();
    assert.equal(optedIntoShims(root), false);
    assert.equal(forgetShims(root), false);
    trust(root, 'h1', { shims: true });
    assert.equal(optedIntoShims(root), true);
    assert.equal(shimsOffWarning(root, { shims: { host: [] } }), null);
    assert.match(shimsOffWarning(root, { shims: null }), /runs pnpm, npm, node & co. on the host again/);
    assert.equal(forgetShims(root), true);
    assert.equal(optedIntoShims(root), false);
    assert.equal(isTrusted(root, 'h1'), true, 'forgetting keeps the approval itself');
    assert.equal(shimsOffWarning(root, { shims: null }), null);
    // A config in a subfolder of an opted-in project: a pod of that project could have planted it.
    trust(root, 'h2', { shims: true });
    assert.match(shimsOffWarning(path.join(root, 'sub'), { shims: null }), /inside .*, which has them/);
  } finally {
    process.env.HOME = prev;
  }
});
