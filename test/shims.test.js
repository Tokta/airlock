// Host shims (src/shim.js, src/commands/shims.js), run the way a terminal would: by path, with the
// shims folder first on PATH and fake "real" pnpm/npm/node behind it, which say they ran on the host.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { dockerfileHash } from '../src/docker.js';
import { shimScript } from '../src/commands/shims.js';
import { cli, sandbox, trustConfig } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const TOOLS = ['pnpm', 'npm', 'npx', 'node', 'tsx', 'yarn', 'bunx', 'bun'];

function run(cmd, args, { cwd, env, input }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    if (input !== undefined) child.stdin.end(input);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function setup({ install = true } = {}) {
  const s = sandbox();
  s.env.FAKE_IMAGE_HASH = dockerfileHash();
  // The fake docker by an absolute node: a `#!/usr/bin/env node` line would find the fake node.
  const bin = s.env.PATH.split(path.delimiter)[0];
  fs.rmSync(path.join(bin, 'docker'));
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\nexec '${process.execPath}' '${path.join(here, 'fixtures', 'fake-docker.js')}' "$@"\n`, { mode: 0o755 });
  const real = path.join(s.dir, 'real');
  fs.mkdirSync(real);
  for (const tool of ['pnpm', 'npm', 'node']) {
    fs.writeFileSync(path.join(real, tool), `#!/bin/sh\necho "host-${tool} $*"\nexit 7\n`, { mode: 0o755 });
  }
  s.shims = path.join(s.hostDir, 'shims');
  s.env.PATH = [s.shims, bin, real, '/usr/bin', '/bin'].join(path.delimiter);
  // The fake keychain in the shim's own node too: a shim pod must never read it.
  s.env.NODE_OPTIONS = `--import ${path.join(here, 'fixtures', 'fake-keychain.js')}`;
  s.shim = (tool, args, { cwd = s.project, env = s.env, input } = {}) => run(path.join(s.shims, tool), args, { cwd, env, input });
  s.config = (obj) => fs.writeFileSync(path.join(s.project, 'claude-pod.config.json'), JSON.stringify(obj));
  s.write = (rel, text, mode = 0o644) => {
    fs.mkdirSync(path.dirname(path.join(s.project, rel)), { recursive: true });
    fs.writeFileSync(path.join(s.project, rel), text, { mode });
  };
  s.cmd = (i) => { const a = s.runs()[i].args; return a.slice(a.indexOf('claude-pod') + 1); };
  if (install) assert.equal((await cli(['shims'], { cwd: s.project, env: s.env })).code, 0);
  return s;
}

// Under the sandbox HOME, like trustConfig.
async function asHome(s, fn) {
  const prev = process.env.HOME;
  process.env.HOME = s.home;
  try {
    return await fn();
  } finally {
    process.env.HOME = prev;
  }
}

test('shims: writes executable launchers that start claude-pod on an absolute node', async () => {
  const s = await setup({ install: false });
  const res = await cli(['shims'], { cwd: s.project, env: s.env });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stdout, 'export PATH="$HOME/.config/claude-pod/shims:$PATH"\n');
  for (const tool of TOOLS) {
    assert.equal(fs.statSync(path.join(s.shims, tool)).mode & 0o777, 0o700, tool);
    assert.ok(fs.readFileSync(path.join(s.shims, tool), 'utf8').includes(`node='${process.execPath}'`), tool);
  }
  // Running it again rewrites them in place.
  assert.equal((await cli(['shims'], { cwd: s.project, env: s.env })).code, 0);
});

test('shims route: no config or no "shims" → the real binary; untrusted or unreadable → refused', async () => {
  const s = await setup();
  let res = await s.shim('pnpm', ['install']);
  assert.equal(res.code, 7, res.stderr);
  assert.equal(res.stdout, 'host-pnpm install\n');
  res = await s.shim('pnpm', ['-v'], { cwd: s.dir }); // outside any project
  assert.equal(res.stdout, 'host-pnpm -v\n');

  s.config({ ports: [3000], envFile: 'missing.env' });
  res = await s.shim('pnpm', ['test']);
  assert.equal(res.stdout, 'host-pnpm test\n', 'a config without "shims" leaves the project alone, even a broken one');

  s.config({ shims: { host: ['dev'] } });
  res = await s.shim('pnpm', ['test']);
  assert.equal(res.code, 1);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /is new or has changed since you approved it, so pnpm doesn't run/);
  assert.match(res.stderr, /claude-pod trust/);
  fs.writeFileSync(path.join(s.project, 'claude-pod.config.json'), '{"shims": ');
  res = await s.shim('pnpm', ['dev']);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /can't be read, so pnpm doesn't run/);
  assert.equal(s.runs().length, 0);
});

test('shims route: everything but host scripts and host node files is exec --no-ports, quiet, without secrets', async () => {
  const s = await setup();
  s.config({ ports: [{ port: 3000, fixed: true }], secrets: ['API_KEY'], shims: { host: ['dev'] } });
  await trustConfig(s);
  assert.equal((await cli(['secret', 'set', 'API_KEY'], { cwd: s.project, env: s.env, input: 'the-key' })).code, 0);

  const cases = [['pnpm', ['test']], ['pnpm', ['--filter', 'web', 'dev']], ['npm', ['dev']], ['npx', ['tsc']], ['tsx', ['a.ts']],
    ['yarn', ['dev']], ['bun', ['run', 'dev']], ['bunx', ['x']], ['node', ['-e', '1']], ['node', []], ['pnpm', []]];
  for (const [i, [tool, args]] of cases.entries()) {
    const res = await s.shim(tool, args, { env: { ...s.env, FAKE_EXIT: '3' } });
    assert.equal(res.code, 3, `${tool} ${args.join(' ')}: ${res.stderr}`);
    const { args: argv, envFile } = s.runs()[i];
    assert.ok(!argv.includes('-p'), 'no ports: never fights the dev server for 3000');
    assert.ok(!argv.includes('-i'), 'stdin is /dev/null: nothing to forward');
    assert.equal(argv[argv.indexOf('--label') + 5], 'claude-pod.mode=exec');
    assert.deepEqual(s.cmd(i), [tool, ...args]);
    assert.doesNotMatch(envFile, /API_KEY|the-key/);
    assert.doesNotMatch(res.stderr, /claude-pod-app|project:/, 'no banner');
  }
  // An explicit exec still gets the secrets.
  assert.equal((await cli(['exec', 'true'], { cwd: s.project, env: s.env })).code, 0);
  assert.match(s.runs().at(-1).envFile, /API_KEY=the-key/);

  // Piped stdin reaches the command (docker forwards it only with -i).
  const res = await s.shim('pnpm', ['exec', 'cat'], { input: 'hello' });
  assert.equal(res.stdout, 'stdin:hello');
  assert.ok(s.runs().at(-1).args.includes('-i'));
  assert.ok(!s.runs().at(-1).args.includes('-t'));
});

test('shims route: a host script is run by claude-pod with /bin/sh, from a read-only package.json', async () => {
  const s = await setup();
  s.config({ readOnly: ['package.json'], shims: { host: ['dev', 'deploy:prod', 'start', 'deploy', 'nope'] } });
  await trustConfig(s);
  s.write('package.json', JSON.stringify({
    scripts: {
      dev: 'printf "dev-ran %s|%s|" "$npm_lifecycle_event" "$PWD"; exit 5',
      'deploy:prod': 'printf "[%s]"',
      start: 'echo "$PATH"',
      deploy: 'echo deploy-script',
      test: 'echo test-script',
    },
  }));
  fs.mkdirSync(path.join(s.project, 'sub'));

  for (const args of [['dev'], ['run', 'dev']]) {
    const res = await s.shim('pnpm', args, { cwd: path.join(s.project, 'sub') });
    assert.equal(res.code, 5, `pnpm ${args.join(' ')}: ${res.stderr}`);
    assert.equal(res.stdout, `dev-ran dev|${s.project}|`, 'in the project root, never via the host pnpm');
  }
  let res = await s.shim('npm', ['run', 'deploy:prod', '--', 'a b', "it's"]);
  assert.equal(res.stdout, "[a b][it's]", 'args after -- are quoted onto the command');
  res = await s.shim('npm', ['run-script', 'dev']);
  assert.equal(res.code, 5);

  // Its PATH: the one you started with, shims included, minus relative entries a pod can fill.
  res = await s.shim('npm', ['start'], { env: { ...s.env, PATH: `node_modules/.bin:${s.env.PATH}` } });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stdout.trim(), s.env.PATH);
  assert.equal(s.runs().length, 0);

  // To the pod: args not after `--`, flags first, pnpm's own command, a script that isn't there,
  // one not in shims.host, and a workspace package's own package.json.
  s.write('pkg/package.json', JSON.stringify({ scripts: { dev: 'echo pkg' } }));
  const pod = [
    ['pnpm', ['dev', '--port', '3']], ['npm', ['--prefix=..', 'run', 'dev']], ['npm', ['run', 'dev', '--prefix=..']],
    ['pnpm', ['deploy']], ['pnpm', ['nope']], ['npm', ['test']], ['pnpm', ['install']],
  ];
  for (const [i, [tool, args]] of pod.entries()) {
    res = await s.shim(tool, args);
    assert.equal(res.code, 0, `${tool} ${args.join(' ')}: ${res.stderr}`);
    assert.deepEqual(s.cmd(i), [tool, ...args]);
  }
  res = await s.shim('pnpm', ['dev'], { cwd: path.join(s.project, 'pkg') });
  assert.deepEqual(s.cmd(pod.length), ['pnpm', 'dev']);
});

test('shims route: a host script whose package.json a pod could write is refused', async () => {
  const s = await setup();
  s.write('package.json', JSON.stringify({ scripts: { dev: 'echo ran' } }));
  s.config({ shims: { host: ['dev'] } });
  await trustConfig(s);
  let res = await s.shim('pnpm', ['dev']);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /"dev" is in shims.host, but .*package.json is not read-only/);
  assert.equal(res.stdout, '');
  assert.equal(s.runs().length, 0);
  assert.match((await cli(['doctor'], { cwd: s.project, env: s.env })).stderr, /refused until "package.json" is in "readOnly"/);

  // Listed in readOnly, but a pod started under an older config, without it, may still be running.
  s.config({ readOnly: ['package.json'], shims: { host: ['dev'] } });
  await trustConfig(s);
  const protect = await import('../src/protect.js');
  await asHome(s, () => protect.recordPending(s.project, 'claude-pod-app-old', [], { extra: [] }));
  res = await s.shim('pnpm', ['dev']);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /not read-only for every pod/);
  await asHome(s, () => protect.clearPending('claude-pod-app-old'));

  // Listed in readOnly, but missing when a running pod started: that pod may have written it.
  s.config({ readOnly: ['package.json'], shims: { host: ['dev'] } });
  await trustConfig(s);
  assert.equal((await s.shim('pnpm', ['dev'])).stdout, 'ran\n');
  const { recordPending, clearPending } = await import('../src/protect.js');
  await asHome(s, () => recordPending(s.project, 'claude-pod-app-aaaaaa', ['package.json']));
  res = await s.shim('pnpm', ['dev']);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /not read-only/);
  await asHome(s, () => clearPending('claude-pod-app-aaaaaa'));
});

test('shims route: node <file> runs on the host only for files no pod can write', async () => {
  const s = await setup();
  s.config({ readOnly: ['scripts', 'tools'], shims: {} });
  await trustConfig(s);
  s.write('scripts/x.js', '');
  s.write('.claude/hooks/h.js', '');
  s.write('src/app.js', '');
  fs.writeFileSync(path.join(s.dir, 'global-cli.js'), '');

  const host = [[path.join(s.dir, 'global-cli.js'), '--flag'], ['scripts/x.js'], ['.claude/hooks/h.js'], [path.join(s.project, 'scripts', 'x.js')]];
  // A file name that differs only in case is the same file on macOS; elsewhere it doesn't exist.
  if (fs.existsSync(path.join(s.project, 'SCRIPTS'))) host.push(['SCRIPTS/x.js']);
  for (const args of host) {
    const res = await s.shim('node', args);
    // The real path it checked, so a symlink flipped in between changes nothing.
    const real = fs.realpathSync.native(path.resolve(s.project, args[0]));
    assert.equal(res.stdout, `host-node ${[real, ...args.slice(1)].join(' ')}\n`, `node ${args.join(' ')}: ${res.stderr}`);
  }
  assert.equal(s.runs().length, 0);

  const pod = [['src/app.js', 'arg'], ['--require', './src/app.js', 'scripts/x.js'], ['missing.js'], ['inspect', 'scripts/x.js']];
  for (const [i, args] of pod.entries()) {
    const res = await s.shim('node', args);
    assert.equal(res.code, 0, `node ${args.join(' ')}: ${res.stderr}`);
    assert.deepEqual(s.cmd(i), ['node', ...args]);
  }
  // Decided by where the file is, not the cwd: from outside the project it still goes to its pod,
  // which starts in the project root.
  let res = await s.shim('node', [path.join(s.project, 'src', 'app.js')], { cwd: s.dir });
  assert.equal(res.code, 0, res.stderr);
  const argv = s.runs().at(-1).args;
  assert.equal(argv[argv.indexOf('-w') + 1], s.project);

  // A "readOnly" folder a running pod found missing may be that pod's work.
  s.write('tools/t.js', '');
  const { recordPending, clearPending } = await import('../src/protect.js');
  await asHome(s, () => recordPending(s.project, 'claude-pod-app-bbbbbb', ['tools']));
  const before = s.runs().length;
  res = await s.shim('node', ['tools/t.js']);
  assert.equal(s.runs().length, before + 1, res.stderr);
  await asHome(s, () => clearPending('claude-pod-app-bbbbbb'));
  assert.ok(!fs.existsSync(path.join(s.project, 'tools')), 'quarantined when that pod run ended');
  s.write('tools/t.js', '');
  res = await s.shim('node', ['tools/t.js']);
  assert.equal(res.stdout, `host-node ${path.join(s.project, 'tools', 't.js')}\n`);

  // A symlink a pod could have written sends the command to the pod, wherever it points.
  fs.writeFileSync(path.join(s.dir, 'loads-config.js'), '');
  fs.symlinkSync(path.join(s.dir, 'loads-config.js'), path.join(s.project, 'build.js'));
  fs.symlinkSync(path.join(s.project, 'scripts'), path.join(s.project, 'via'));
  s.write('scripts/own-link.js', '');
  fs.symlinkSync(path.join(s.dir, 'loads-config.js'), path.join(s.project, 'scripts', 'link.js'));
  let n;
  for (const args of [['build.js'], ['via/x.js']]) {
    n = s.runs().length;
    res = await s.shim('node', args);
    assert.equal(s.runs().length, n + 1, `node ${args[0]} goes to the pod: ${res.stdout}${res.stderr}`);
  }
  // A link inside a link's target (an `npm link`ed package whose bin a pod turned into a link).
  fs.mkdirSync(path.join(s.dir, 'gbin'));
  s.write('bin/cli.js', '');
  fs.rmSync(path.join(s.project, 'bin', 'cli.js'));
  fs.symlinkSync(path.join(s.dir, 'loads-config.js'), path.join(s.project, 'bin', 'cli.js'));
  fs.symlinkSync(path.join('..', 'work', 'app', 'bin', 'cli.js'), path.join(s.dir, 'gbin', 'mytool'));
  n = s.runs().length;
  res = await s.shim('node', [path.join(s.dir, 'gbin', 'mytool')], { cwd: s.dir });
  assert.equal(s.runs().length, n + 1, `a pod-written link behind another goes to the pod: ${res.stdout}${res.stderr}`);
  // The same chain ending in a file of yours runs on the host.
  fs.symlinkSync(path.join(s.dir, 'loads-config.js'), path.join(s.dir, 'gbin', 'other'));
  res = await s.shim('node', [path.join(s.dir, 'gbin', 'other')], { cwd: s.dir });
  assert.equal(res.stdout, `host-node ${path.join(s.dir, 'loads-config.js')}\n`);

  // One under "readOnly" is yours: no pod can have written it.
  res = await s.shim('node', ['scripts/link.js']);
  assert.equal(res.stdout, `host-node ${path.join(s.dir, 'loads-config.js')}\n`);

  // Options before a project file, or a file without its extension or a folder, from outside the
  // project: still its pod.
  s.write('src/index.js', '');
  for (const args of [['--enable-source-maps', path.join(s.project, 'src', 'app.js')], [path.join(s.project, 'src', 'app')], [path.join(s.project, 'src')]]) {
    const n = s.runs().length;
    res = await s.shim('node', args, { cwd: s.dir });
    assert.equal(s.runs().length, n + 1, `node ${args.join(' ')}: ${res.stdout}${res.stderr}`);
    const argv = s.runs().at(-1).args;
    assert.equal(argv[argv.indexOf('-w') + 1], s.project);
  }

  // A "readOnly" entry a running pod started without (an older config) is not locked for it.
  await asHome(s, () => recordPending(s.project, 'claude-pod-app-cccccc', [], { extra: ['tools'] }));
  res = await s.shim('node', ['scripts/x.js']);
  assert.match(res.stdout, /^stdin:/, 'to the pod while that run lasts');
  await asHome(s, () => clearPending('claude-pod-app-cccccc'));
});

test('shims: the launcher drops relative PATH entries, and survives claude-pod or its node being gone', async () => {
  const s = await setup();
  s.write('node_modules/.bin/pnpm', '#!/bin/sh\necho planted\n', 0o755);
  let res = await s.shim('pnpm', ['-v'], { env: { ...s.env, PATH: `node_modules/.bin:${s.env.PATH}` } });
  assert.equal(res.stdout, 'host-pnpm -v\n', res.stderr);

  const dir = path.join(s.dir, 'alt-shims');
  fs.mkdirSync(dir);
  const env = { ...s.env, PATH: s.env.PATH.replace(s.shims, dir) };
  fs.writeFileSync(path.join(dir, 'pnpm'), shimScript('pnpm', { dir, shimJs: path.join(s.dir, 'gone.js') }), { mode: 0o700 });
  res = await run(path.join(dir, 'pnpm'), ['-v'], { cwd: s.project, env });
  assert.equal(res.stdout, 'host-pnpm -v\n');
  assert.match(res.stderr, /gone.js is gone, so pnpm runs on the host. Remove .*alt-shims from PATH/);

  // The node it was written with is gone: the next real node on PATH runs the shim.
  fs.writeFileSync(path.join(dir, 'pnpm'), shimScript('pnpm', { dir, node: path.join(s.dir, 'no-node') }), { mode: 0o700 });
  const onlyNode = path.join(s.dir, 'only-node');
  fs.mkdirSync(onlyNode);
  fs.symlinkSync(process.execPath, path.join(onlyNode, 'node'));
  res = await run(path.join(dir, 'pnpm'), ['-v'], { cwd: s.project, env: { ...env, PATH: [dir, onlyNode, '/usr/bin', '/bin'].join(':') } });
  assert.equal(res.code, 1, 'no real pnpm on this PATH: but the shim itself ran');
  assert.match(res.stderr, /pnpm not found on PATH after the claude-pod shims/);
});

test('shims: a launcher that finds itself again on PATH stops instead of looping', async () => {
  const s = await setup();
  const res = await s.shim('node', ['-v'], { env: { ...s.env, CLAUDE_POD_IN_SHIM: '1' } });
  assert.equal(res.code, 127);
  assert.match(res.stderr, /found the shims again on PATH/);
  // A trailing slash on the PATH entry is still recognised as the shims folder.
  const ok = await s.shim('pnpm', ['-v'], { env: { ...s.env, PATH: s.env.PATH.replace(/shims/, 'shims/') } });
  assert.equal(ok.stdout, 'host-pnpm -v\n', ok.stderr);
});

test('doctor: shims ahead of the real binaries on PATH', async () => {
  const s = await setup({ install: false });
  s.config({ shims: { host: [] } });
  await trustConfig(s);
  let res = await cli(['doctor'], { cwd: s.project, env: s.env });
  assert.match(res.stderr, /shims: not installed/);
  assert.equal((await cli(['shims'], { cwd: s.project, env: s.env })).code, 0);
  res = await cli(['doctor'], { cwd: s.project, env: s.env });
  assert.match(res.stderr, /shims on PATH ahead of the real/);
  const real = path.join(s.dir, 'real');
  res = await cli(['doctor'], { cwd: s.project, env: { ...s.env, PATH: `${real}:${s.env.PATH}` } });
  assert.match(res.stderr, /shims are on PATH after .*real\/pnpm, .*real\/npm, .*real\/node, which run on the host/);
  res = await cli(['doctor'], { cwd: s.project, env: { ...s.env, PATH: process.env.PATH } });
  assert.match(res.stderr, /are not on PATH/);
});

test('shims: a pod can\'t turn an opted-in project\'s shims off by editing or deleting its config', async () => {
  const s = await setup();
  s.config({ shims: { host: [] } });
  await trustConfig(s);
  const file = path.join(s.project, 'claude-pod.config.json');

  s.config({}); // "shims" removed, not approved
  let res = await s.shim('pnpm', ['install']);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /is new or has changed since you approved it/);
  res = await cli(['shims', '--forget'], { cwd: s.project, env: s.env });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /is still there, so there's nothing to forget/);

  fs.mkdirSync(path.join(s.project, 'sub'));
  fs.writeFileSync(path.join(s.project, 'sub', 'claude-pod.config.json'), '{}'); // planted nearer config
  res = await s.shim('pnpm', ['install'], { cwd: path.join(s.project, 'sub') });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /sub\/claude-pod.config.json is new or has changed/);
  fs.rmSync(path.join(s.project, 'sub', 'claude-pod.config.json'));

  fs.rmSync(file); // config deleted
  res = await s.shim('pnpm', ['install']);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /is gone, and it had "shims"/);
  assert.doesNotMatch(res.stderr, /--forget/, 'no command for an agent to copy');
  assert.equal(s.runs().length, 0);
  assert.doesNotMatch(res.stdout, /host-pnpm/);
  // Neither init (a fresh trusted config) nor an unattended --forget ends the opt-in.
  res = await cli(['init'], { cwd: s.project, env: s.env });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /had a claude-pod.config.json with "shims", and it is gone/);
  assert.ok(!fs.existsSync(file));
  res = await cli(['shims', '--forget'], { cwd: s.project, env: s.env });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /needs a terminal/);
  assert.equal((await s.shim('pnpm', ['install'])).code, 1);

  // You removed it on purpose (what --forget does once you confirm): the real pnpm runs again.
  const c = await import('../src/config.js');
  assert.equal(await asHome(s, () => c.forgetShims(s.project)), true);
  res = await s.shim('pnpm', ['install']);
  assert.equal(res.stdout, 'host-pnpm install\n', res.stderr);

  // Approving a config without "shims" turns them off too.
  s.config({ shims: { host: [] } });
  await trustConfig(s);
  s.config({});
  await trustConfig(s);
  res = await s.shim('pnpm', ['install']);
  assert.equal(res.stdout, 'host-pnpm install\n', res.stderr);
});

test('shims: what runs on the host keeps the shims, never loops, dies by the same signal, and keeps IPC', async () => {
  const s = await setup();
  // A second spelling of the shims folder on PATH (a symlink to it) must not start the shim again.
  const alias = path.join(s.dir, 'shims-alias');
  fs.symlinkSync(s.shims, alias);
  let res = await s.shim('pnpm', ['-v'], { cwd: s.dir, env: { ...s.env, PATH: `${alias}:${s.env.PATH}` } });
  assert.equal(res.stdout, 'host-pnpm -v\n', res.stderr);

  // In an opted-in project, children of a host command see the shims (so a global tool's own
  // `pnpm build` still goes to a pod), minus relative entries. Elsewhere they don't: they'd only pay.
  s.config({ shims: {} });
  await trustConfig(s);
  fs.writeFileSync(path.join(s.dir, 'real', 'node'), '#!/bin/sh\necho "$PATH"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(s.dir, 'tool.js'), '');
  const stripped = s.env.PATH.split(':').slice(1).join(':');
  res = await s.shim('node', [path.join(s.dir, 'tool.js')], { env: { ...s.env, PATH: `rel/bin:${s.env.PATH}` } });
  assert.equal(res.stdout.trim(), s.env.PATH, res.stderr);
  res = await s.shim('node', [path.join(s.dir, 'tool.js')], { cwd: s.dir, env: { ...s.env, PATH: `rel/bin:${s.env.PATH}` } });
  assert.equal(res.stdout.trim(), stripped, res.stderr);

  // Killed by a signal: the shim dies by it too.
  fs.writeFileSync(path.join(s.dir, 'real', 'npm'), '#!/bin/sh\nkill -TERM $$\n', { mode: 0o755 });
  const signal = await new Promise((resolve) => {
    spawn(path.join(s.shims, 'npm'), [], { cwd: s.dir, env: s.env, stdio: 'ignore' }).on('exit', (code, sig) => resolve(sig));
  });
  assert.equal(signal, 'SIGTERM');

  // A SIGINT sent to the shim alone (no terminal) reaches the command.
  fs.writeFileSync(path.join(s.dir, 'real', 'npm'), '#!/bin/sh\ntrap "echo got-int; exit 3" INT\necho ready\nwhile :; do sleep 0.05; done\n', { mode: 0o755 });
  const int = await new Promise((resolve) => {
    const child = spawn(path.join(s.shims, 'npm'), [], { cwd: s.dir, env: s.env, stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      if (out === 'ready\n') child.kill('SIGINT');
    });
    child.on('exit', (code) => resolve({ code, out }));
  });
  assert.deepEqual(int, { code: 3, out: 'ready\ngot-int\n' });

  // A parent talking to `node` over IPC reaches the real node, not the shim's.
  const onlyNode = path.join(s.dir, 'only-node');
  fs.mkdirSync(onlyNode);
  fs.symlinkSync(process.execPath, path.join(onlyNode, 'node'));
  fs.writeFileSync(path.join(s.dir, 'child.js'), 'process.send("hi from child"); process.disconnect();');
  const got = await new Promise((resolve) => {
    const child = spawn(path.join(s.shims, 'node'), [path.join(s.dir, 'child.js')], {
      cwd: s.dir, env: { ...s.env, NODE_OPTIONS: '', PATH: [s.shims, onlyNode, '/usr/bin', '/bin'].join(':') }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    child.on('message', resolve);
    child.on('exit', () => resolve(null));
  });
  assert.equal(got, 'hi from child');

  // A current folder that is gone: an error, not a stack trace.
  const gone = path.join(s.dir, 'gone');
  fs.mkdirSync(gone);
  res = await run('/bin/sh', ['-c', `cd '${gone}' && rmdir '${gone}' && '${path.join(s.shims, 'pnpm')}' -v`], { cwd: s.dir, env: s.env });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /the current folder can't be read/);
});

test('shims: outside opted-in projects the launcher runs the real command without starting node', async () => {
  const s = await setup();
  // A launcher whose claude-pod is gone says so whenever it gets past the fast path.
  const dir = path.join(s.dir, 'alt-shims');
  fs.mkdirSync(dir);
  const env = { ...s.env, PATH: s.env.PATH.replace(s.shims, dir) };
  fs.writeFileSync(path.join(dir, 'pnpm'), shimScript('pnpm', { dir, shimJs: path.join(s.dir, 'gone.js'), index: path.join(s.hostDir, 'shims-opted') }), { mode: 0o700 });
  const pnpm = (cwd) => run(path.join(dir, 'pnpm'), ['-v'], { cwd, env });

  let res = await pnpm(s.dir);
  assert.equal(res.stdout, 'host-pnpm -v\n');
  assert.equal(res.stderr, '', 'fast path: no config, nothing opted in');
  s.config({});
  res = await pnpm(s.project);
  assert.match(res.stderr, /is gone/, 'a config above: the shim decides');

  // An opted-in project whose config is gone, reached through a symlink: still the slow path.
  s.config({ shims: {} });
  await trustConfig(s);
  fs.rmSync(path.join(s.project, 'claude-pod.config.json'));
  fs.mkdirSync(path.join(s.project, 'sub'));
  fs.symlinkSync(s.project, path.join(s.dir, 'link-to-app'));
  res = await pnpm(path.join(s.dir, 'link-to-app', 'sub'));
  assert.match(res.stderr, /is gone/);
  res = await s.shim('pnpm', ['install'], { cwd: path.join(s.dir, 'link-to-app', 'sub') });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /is gone, and it had "shims"/);

  // An index it can't read: the slow path.
  fs.chmodSync(path.join(s.hostDir, 'shims-opted'), 0);
  res = await pnpm(s.dir);
  assert.match(res.stderr, /is gone/);
  assert.doesNotMatch(res.stderr, /ermission denied/);
  fs.chmodSync(path.join(s.hostDir, 'shims-opted'), 0o600);

  // No index yet (approvals from before the shims): always the slow path.
  fs.rmSync(path.join(s.hostDir, 'shims-opted'));
  res = await pnpm(s.dir);
  assert.match(res.stderr, /is gone/);
});

test('shims: a readOnly file a stale pod changed after you approved it is refused until you approve it again', async () => {
  const s = await setup();
  s.write('package.json', JSON.stringify({ scripts: { dev: 'echo ran' } }));
  s.write('scripts/x.js', '');
  s.config({ shims: { host: ['dev'] } });
  await trustConfig(s);
  // A pod started under that config (no readOnly) is running when you approve the next one.
  const protect = await import('../src/protect.js');
  const c = await import('../src/config.js');
  await asHome(s, () => protect.recordPending(s.project, 'claude-pod-app-stale', [], { extra: [] }));
  s.config({ readOnly: ['package.json', 'scripts'], shims: { host: ['dev'] } });
  await trustConfig(s);
  let res = await s.shim('pnpm', ['dev']);
  assert.match(res.stderr, /not read-only for every pod/);

  // It changes package.json, and respells the entry, which you approve, then it exits; or the entry
  // leaves the list and comes back. The fingerprint you approved first still stands.
  s.write('package.json', JSON.stringify({ scripts: { dev: 'echo pwned' } }));
  s.config({ readOnly: ['Package.json', 'scripts'], shims: { host: ['dev'] } });
  await trustConfig(s);
  s.config({ readOnly: ['scripts'], shims: { host: ['dev'] } });
  await trustConfig(s);
  s.config({ readOnly: ['package.json', 'scripts'], shims: { host: ['dev'] } });
  await trustConfig(s);
  await asHome(s, () => protect.clearPending('claude-pod-app-stale'));
  res = await s.shim('pnpm', ['dev']);
  assert.equal(res.code, 1);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /package.json changed after you approved claude-pod.config.json, while a pod that could still write it was running/);
  assert.match(res.stderr, /claude-pod trust/);
  // scripts/ didn't change: it runs on the host, and stops being watched.
  res = await s.shim('node', ['scripts/x.js']);
  assert.equal(res.stdout, `host-node ${path.join(s.project, 'scripts', 'x.js')}\n`, res.stderr);
  assert.deepEqual(await asHome(s, () => c.changedReadOnly(s.project, ['package.json', 'scripts'])), ['package.json']);
  // Re-approving the config itself doesn't approve the file.
  s.config({ readOnly: ['package.json', 'scripts'], shims: { host: ['dev'] }, env: {} });
  await trustConfig(s);
  assert.equal((await s.shim('pnpm', ['dev'])).code, 1);
  // `claude-pod trust` asks about it; without a terminal it refuses.
  res = await cli(['trust'], { cwd: s.project, env: s.env });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /package.json changed while a pod that could write them was running/);
  // What it does once you say yes.
  await asHome(s, () => c.approveReadOnly(s.project, ['package.json']));
  res = await s.shim('pnpm', ['dev']);
  assert.equal(res.stdout, 'pwned\n');
});
