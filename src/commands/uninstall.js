import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { docker } from '../docker.js';
import { IMAGE, hostDir, stateRoot } from '../paths.js';
import { CliError, bold, detail, info, ok } from '../ui.js';

export const UNINSTALL_HELP = `Usage: airlock uninstall [--yes]

Removes the '${IMAGE}' image, the pods' state (~/.airlock: session history, package caches) and the host-only
state (~/.config/airlock: login token, trusted configs).
Does not remove the airlock command itself (\`npm uninstall -g airlock\`), or keychain
secrets stored with \`airlock secret set\` (remove those with \`airlock secret rm\`).`;

// Pods can leave folders without write permission in their state (a package cache, say), which
// rmSync can't empty. Make every real folder owner-writable (never following a symlink), then
// retry once.
function removeTree(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return;
  } catch (e) {
    if (e.code !== 'EACCES' && e.code !== 'EPERM') throw e;
  }
  const unlock = (d) => {
    const st = fs.lstatSync(d);
    if (!st.isDirectory()) return;
    fs.chmodSync(d, st.mode | 0o700);
    for (const name of fs.readdirSync(d)) unlock(path.join(d, name));
  };
  unlock(dir);
  fs.rmSync(dir, { recursive: true, force: true });
}

export async function uninstall(argv) {
  const { values } = parseArgs({ args: argv, options: { yes: { type: 'boolean', short: 'y' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) {
    process.stdout.write(`${UNINSTALL_HELP}\n`);
    return 0;
  }
  // Host-only state (the login token) first, so it goes even if the pod state can't be removed.
  const dirs = [hostDir(), stateRoot()];
  info('Will remove');
  detail(`image: ${IMAGE}`);
  detail(`dir:   ${dirs[0]} (login token, trusted configs)`);
  detail(`dir:   ${dirs[1]} (pod session history, package caches)`);

  if (!values.yes) {
    if (!process.stdin.isTTY) throw new CliError('Refusing to uninstall without confirmation.', { hint: 'Pass --yes.' });
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    const reply = await rl.question('Proceed? [y/N] ');
    rl.close();
    if (!/^y$/i.test(reply.trim())) {
      process.stderr.write('Aborted.\n');
      return 0;
    }
  }

  if (docker(['image', 'ls', '-q', IMAGE]).stdout.trim()) {
    const res = docker(['rmi', '-f', IMAGE]);
    if (res.status !== 0) throw new CliError(`docker rmi failed: ${res.stderr.trim()}`);
    ok(`Removed image '${IMAGE}'`);
  } else {
    ok(`Image '${IMAGE}' was not present`);
  }
  for (const dir of dirs) {
    if (fs.existsSync(dir)) {
      removeTree(dir);
      ok(`Removed ${dir}`);
    } else {
      ok(`${dir} was not present`);
    }
  }
  process.stderr.write(`  To remove the command too: ${bold('npm uninstall -g airlock')}\n`);
  process.stderr.write('  If you put ~/.config/airlock/shims on PATH in your shell rc, remove that line.\n');
  return 0;
}
