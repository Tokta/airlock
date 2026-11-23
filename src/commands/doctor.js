import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { assertSafeRoot, findProjectRoot, isTrusted, loadConfig } from '../config.js';
import { docker, imageStatus } from '../docker.js';
import { readToken } from '../host.js';
import { IMAGE, hostDir, projectStateDir, stateRoot, tokenPath } from '../paths.js';
import { containerExists } from '../launch.js';
import { hasSecret, supported } from '../keychain.js';
import { listOrphans } from '../protect.js';
import { SHIM_TOOLS, shimsDir } from '../shim.js';
import { kind } from '../safefs.js';
import { bold, err, info, ok, warn } from '../ui.js';

export const DOCTOR_HELP = `Usage: airlock doctor

Checks Docker, the image, the login token and the current project's config.`;

const isExecutable = (p) => {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};
const PATH_ENTRIES = () => (process.env.PATH || '').split(path.delimiter).map((d) => d.replace(/\/+$/, ''));

export async function doctor(argv) {
  const { values } = parseArgs({ args: argv, options: { help: { type: 'boolean', short: 'h' } } });
  if (values.help) {
    process.stdout.write(`${DOCTOR_HELP}\n`);
    return 0;
  }
  let failed = false;
  const fail = (msg) => {
    err(msg);
    failed = true;
  };

  info('Host');
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 20) ok(`node ${process.versions.node}`);
  else fail(`node ${process.versions.node} — airlock needs Node 20+`);

  let dockerUp = false;
  try {
    ok(docker(['--version']).stdout.trim());
    dockerUp = docker(['info'], { stdio: 'ignore' }).status === 0;
    if (dockerUp) ok('Docker daemon running');
    else fail('Docker daemon is not running');
  } catch (e) {
    fail(e.message);
  }
  if (dockerUp) {
    const img = imageStatus();
    if (!img.exists) fail(`image '${IMAGE}' not built — run ${bold('airlock build')}`);
    else if (img.replaced) fail(`image '${IMAGE}' is not the one airlock built — run ${bold('airlock build')}`);
    else if (!img.recorded) warn(`image '${IMAGE}' predates this version — run ${bold('airlock build')}`);
    else if (img.stale) warn(`image '${IMAGE}' was built from a different Dockerfile — run ${bold('airlock build')}`);
    else ok(`image '${IMAGE}' up to date`);
  }

  info('Login');
  if (readToken()) ok(`token stored in ${tokenPath()}`);
  else fail(`no login token — run ${bold('claude setup-token')} on the host, then ${bold('airlock auth')}`);
  if (kind(hostDir()) === 'dir') ok(`${hostDir()} (host-only, never mounted)`);
  const legacy = path.join(stateRoot(), '.credentials.json');
  if (kind(legacy) !== 'missing') warn(`${legacy} is an old copied login (with a refresh token) that is no longer used — delete it, or run ${bold('airlock auth')}`);
  for (const old of ['projects', 'settings.json', '.claude.json']) {
    if (kind(path.join(stateRoot(), old)) !== 'missing') {
      warn(`${path.join(stateRoot(), old)} is state from the old shared layout (pods now use ${path.join(stateRoot(), 'pods')}/<project>); delete it when you no longer need the history`);
      break;
    }
  }

  if (dockerUp) {
    for (const rec of listOrphans(containerExists)) {
      warn(`an interrupted run in ${rec.root} may have left files to quarantine (${rec.missing.join(', ')}); the next airlock launch there sweeps them`);
    }
  }

  // Shims only work ahead of the real binaries on PATH: a pnpm found first runs on the host.
  if (kind(shimsDir()) === 'dir') {
    info('Shims');
    const entries = PATH_ENTRIES();
    const at = entries.indexOf(shimsDir());
    const fix = `put \`export PATH="${shimsDir()}:$PATH"\` last in your shell rc`;
    const before = at === -1 ? [] : entries.slice(0, at).flatMap((d) => SHIM_TOOLS.filter((t) => isExecutable(path.join(d, t))).map((t) => path.join(d, t)));
    if (at === -1) warn(`shims in ${shimsDir()} are not on PATH — ${fix}`);
    else if (before.length) warn(`shims are on PATH after ${before.join(', ')}, which run${before.length === 1 ? 's' : ''} on the host — ${fix}`);
    else ok(`shims on PATH ahead of the real ${SHIM_TOOLS.join('/')} (${shimsDir()})`);
  }

  info('Project');
  try {
    const found = findProjectRoot();
    assertSafeRoot(found.root);
    ok(`root: ${found.root}`);
    ok(`pod state: ${projectStateDir(found.root)}`);
    const config = loadConfig(found);
    if (!found.configPath) ok('no airlock.config.json (defaults: default network, no ports, no extra env)');
    else {
      ok(`config: ${found.configPath}`);
      if (isTrusted(found.root, config.hash)) ok('config trusted');
      else fail(`config is new or changed since you approved it — review it, then ${bold('airlock trust')}`);
      if (config.network && config.network !== 'none' && dockerUp) {
        const res = docker(['network', 'inspect', '--format', '{{.Driver}}', config.network]);
        if (res.status !== 0) fail(`network ${config.network} not found — start your stack (docker compose up -d)`);
        else if (res.stdout.trim() !== 'bridge') fail(`network ${config.network} uses the '${res.stdout.trim()}' driver; only bridge is allowed`);
        else ok(`network ${config.network} exists (bridge)`);
      }
      if (config.ports.length) {
        const list = config.ports.map((p) => `${p.port} → ${p.fixed ? `127.0.0.1:${p.port} (fixed)` : 'a free host port'}`);
        ok(`ports: ${list.join(', ')}`);
      }
      if (Object.keys(config.env).length) ok(`env: ${Object.keys(config.env).join(', ')}`);
      if (config.shims) {
        ok(`shims: on${config.shims.host.length ? `; on the host: ${config.shims.host.join(', ')}` : ''}`);
        if (kind(shimsDir()) !== 'dir') warn(`shims: not installed — run ${bold('airlock shims')}`);
        // A host script is defined in package.json, which a pod could otherwise rewrite.
        if (config.shims.host.length && !config.readOnly.some((p) => p.toLowerCase() === 'package.json')) {
          warn('shims.host scripts are refused until "package.json" is in "readOnly" (add the files they call too)');
        }
      }
      if (config.secrets.length) {
        if (!supported()) warn('secrets: keychain secrets are macOS-only for now; pods start without them');
        else if (!isTrusted(found.root, config.hash)) warn('secrets: not checked until the config is trusted');
        else {
          for (const name of config.secrets) {
            try {
              if (hasSecret(found.root, name)) ok(`secret ${name}: stored (shell and exec pods only)`);
              else warn(`secret ${name}: missing — run ${bold(`airlock secret set ${name}`)}`);
            } catch (e) {
              fail(`secret ${name}: ${e.message}`);
            }
          }
        }
      }
    }
  } catch (e) {
    fail(e.message);
  }

  return failed ? 1 : 0;
}
