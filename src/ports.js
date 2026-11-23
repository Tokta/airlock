import net from 'node:net';
import { CliError } from './ui.js';

// Asks the OS for a free loopback port by binding port 0 and reading back what it assigned.
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Whether something already answers on host:port. A bind test alone misses a server on the
// wildcard address on macOS (binding 127.0.0.1 next to it succeeds), and a dev server on `localhost`
// may be on ::1 only, which a browser reaches first.
function answers(port, host) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (yes) => {
      sock.destroy();
      resolve(yes);
    };
    sock.setTimeout(500, () => done(false));
    sock.on('connect', () => done(true));
    sock.on('error', () => done(false));
  });
}

// Whether binding 127.0.0.1:port fails because it is taken (held but not listening). Any other
// failure, such as EACCES for a port below 1024 that Docker itself can still publish, is left
// for Docker to decide.
function boundElsewhere(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', (e) => resolve(e.code === 'EADDRINUSE'));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(false)));
  });
}

// The default probe for a fixed port: free means nothing answers on either loopback address and
// nothing holds it. Docker still has the last word, so a port taken in between fails at
// `docker run` ("ports are not available").
export async function portIsFree(port) {
  const [v4, v6, held] = await Promise.all([answers(port, '127.0.0.1'), answers(port, '::1'), boundElsewhere(port)]);
  return !v4 && !v6 && !held;
}

// Maps each config port to a host port. A fixed one keeps its own number and is never moved to
// another port: the app's callbacks and cookies point at it, so a busy fixed port is an error.
// Only the dev-server paths (`exec`, `shell`) own fixed ports. Agent pods (`claude`, `run`) pass
// `ownFixed: false` and get a random port for every entry: a hostile agent must never serve the
// real dev origin, where it would receive OAuth redirects and could plant a service worker that
// outlives the pod. Other ports get distinct free host ports. We pick host ports ourselves (rather
// than letting Docker choose with `-p 127.0.0.1::PORT`) so they are known before the container
// starts and can be injected as AIRLOCK_PORT_<container> env vars.
export async function allocatePorts(entries, { isFree = portIsFree, ownFixed = true, busyHint = 'airlock exec --no-ports' } = {}) {
  const fixed = (e) => ownFixed && e.fixed;
  // A random port must never land on a fixed port's number, even in an agent pod: an ephemeral
  // port like 51256 can be both.
  const used = new Set(entries.filter((e) => e.fixed).map((e) => e.port));
  for (const e of entries) {
    if (!fixed(e)) continue;
    if (!(await isFree(e.port))) {
      throw new CliError(`port ${e.port} is in use — is the dev server already running?`, {
        hint: `Stop it first (\`airlock ps\` lists pods), or use ${busyHint}, which publishes no ports.`,
      });
    }
  }
  const mappings = [];
  for (const e of entries) {
    let host = e.port;
    if (!fixed(e)) {
      do host = await freePort(); while (used.has(host));
      used.add(host);
    }
    mappings.push({ container: e.port, host });
  }
  return mappings;
}
