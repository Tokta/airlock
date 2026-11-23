import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';
import { buildRunArgs } from '../src/docker.js';
import { allocatePorts, portIsFree } from '../src/ports.js';

const base = {
  name: 'airlock-app-abc123', mode: 'run', root: '/work/app', workdir: '/work/app/sub',
  stateDir: '/home/me/.airlock/pods/app-123', uid: 501, gid: 20, interactive: false, tty: false,
  envFile: '/home/me/.config/airlock/run/x/env',
};

test('hardening, mounts and identity flags are always present', () => {
  const args = buildRunArgs({ ...base, command: ['claude', '--version'] });
  for (const flag of ['--rm', '--init', '--stop-timeout=10', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=4096']) {
    assert.ok(args.includes(flag), flag);
  }
  const after = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(after('--user'), '501:20');
  assert.equal(after('--name'), 'airlock-app-abc123');
  assert.equal(after('-w'), '/work/app/sub');
  assert.equal(after('--env-file'), base.envFile);
  assert.ok(args.includes('/work/app:/work/app'));
  assert.ok(args.includes('/home/me/.airlock/pods/app-123:/home/airlock/.claude'));
  assert.ok(args.includes('CLAUDE_CONFIG_DIR=/home/airlock/.claude'));
  assert.ok(!args.some((a) => a.endsWith('.claude.json')), 'no single-file mounts');
  assert.deepEqual(args.slice(-3), ['airlock', 'claude', '--version']);
  assert.ok(!args.includes('-i') && !args.includes('-t'));
});

test('protected paths are mounted read-only after the project mount', () => {
  const args = buildRunArgs({ ...base, pinned: ['/work/app/.git'], readOnly: ['/work/app/.git/hooks', '/work/app/.claude'] });
  const project = args.indexOf('/work/app:/work/app');
  const pinned = args.indexOf('/work/app/.git:/work/app/.git');
  assert.ok(pinned > project && pinned < args.indexOf('/work/app/.git/hooks:/work/app/.git/hooks:ro'));
  assert.ok(args.indexOf('/work/app/.git/hooks:/work/app/.git/hooks:ro') > project);
  assert.ok(args.indexOf('/work/app/.claude:/work/app/.claude:ro') > project);
});

test('paths with colons are refused', () => {
  assert.throws(() => buildRunArgs({ ...base, root: '/work/a:/etc', workdir: '/work/a:/etc' }), /colon/);
  assert.throws(() => buildRunArgs({ ...base, readOnly: ['/work/app/x:y'] }), /colon/);
});

test('ports bind to loopback only and are exposed as env', () => {
  const args = buildRunArgs({ ...base, ports: [{ container: 3000, host: 51234 }] });
  assert.ok(args.includes('127.0.0.1:51234:3000'));
  assert.ok(args.includes('AIRLOCK_PORT_3000=51234'));
});

test('network, resources and tty flags', () => {
  const args = buildRunArgs({ ...base, interactive: true, tty: true, network: 'none', resources: { pids: 100, memory: '4g', cpus: 2 } });
  for (const flag of ['-i', '-t', '--network=none', '--pids-limit=100', '--memory=4g', '--cpus=2']) assert.ok(args.includes(flag), flag);
});

const random = (port) => ({ port, fixed: false });

test('allocatePorts returns distinct host ports', async () => {
  const ports = await allocatePorts([random(3000), random(3131), random(8080)]);
  assert.deepEqual(ports.map((p) => p.container), [3000, 3131, 8080]);
  assert.equal(new Set(ports.map((p) => p.host)).size, 3);
});

test('a fixed port keeps its number, in config order, and a random one never takes it', async () => {
  const probed = [];
  const isFree = async (port) => {
    probed.push(port);
    return true;
  };
  const ports = await allocatePorts([random(8080), { port: 3000, fixed: true }], { isFree });
  assert.deepEqual(probed, [3000], 'only fixed ports are probed');
  assert.deepEqual(ports[1], { container: 3000, host: 3000 });
  assert.equal(ports[0].container, 8080);
  assert.notEqual(ports[0].host, 3000);
  // The fixed port is published on the host as-is and the env var names the same number.
  const args = buildRunArgs({ ...base, ports });
  assert.ok(args.includes('127.0.0.1:3000:3000'));
  assert.ok(args.includes('AIRLOCK_PORT_3000=3000'));
});

test('a busy fixed port refuses to start, never falls back to a random port', async () => {
  await assert.rejects(
    allocatePorts([{ port: 3000, fixed: true }], { isFree: async () => false }),
    /port 3000 is in use — is the dev server already running\?/,
  );
});

test('a random port never takes a fixed number, even in an agent pod', async () => {
  // Fix every port the OS would hand out next, so freePort must skip them.
  const next = await allocatePorts([random(1)]);
  const near = Array.from({ length: 20 }, (_, i) => next[0].host + 1 + i).filter((p) => p <= 65535);
  const entries = [...near.map((port) => ({ port, fixed: true })), random(9)];
  for (const ownFixed of [false, true]) {
    const ports = await allocatePorts(entries, { ownFixed, isFree: async () => true });
    const hosts = ports.map((p) => p.host);
    const randoms = ownFixed ? hosts.slice(-1) : hosts;
    for (const h of randoms) assert.ok(!near.includes(h), `${h} is a fixed number`);
  }
});

test('ownFixed: false (agent pods) gives a fixed entry a random port and never probes it', async () => {
  const ports = await allocatePorts([{ port: 3000, fixed: true }, random(8080)], {
    ownFixed: false, isFree: async () => assert.fail('no probe'),
  });
  assert.deepEqual(ports.map((p) => p.container), [3000, 8080]);
  assert.notEqual(ports[0].host, 3000);
});

test('portIsFree: a privileged port nobody serves is free (Docker may still publish it)', async () => {
  assert.equal(await portIsFree(1), true);
});

test('portIsFree: a listening server, on loopback or the wildcard address, makes the port busy', async () => {
  for (const host of ['127.0.0.1', '0.0.0.0', '::1']) {
    const srv = net.createServer();
    try {
      await new Promise((resolve, reject) => {
        srv.on('error', reject);
        srv.listen(0, host, resolve);
      });
    } catch {
      continue; // no IPv6 loopback here
    }
    const { port } = srv.address();
    assert.equal(await portIsFree(port), false, host);
    await new Promise((resolve) => srv.close(resolve));
    assert.equal(await portIsFree(port), true, `${host} after close`);
  }
});
