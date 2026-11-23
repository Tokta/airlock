// `airlock migrate`: moves a setup made under the project's old name, claude-pod, to Airlock's
// names. This file is the only place the old names live; nothing else reads them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { docker } from '../docker.js';
import { moveService, supported as keychainSupported } from '../keychain.js';
import { CONFIG_FILE, IMAGE, hostDir, stateRoot, trustDir } from '../paths.js';
import { kind, readRegularFile } from '../safefs.js';
import { pathLine, writeShims } from './shims.js';
import { CliError, bold, clean, info, ok, warn } from '../ui.js';

const OLD = 'claude-pod';
const OLD_CONFIG = `${OLD}.config.json`;
const oldHostDir = () => path.join(os.homedir(), '.config', OLD);
const oldStateRoot = () => path.join(os.homedir(), `.${OLD}`);

export const MIGRATE_HELP = `Usage: airlock migrate

Moves a setup made under airlock's old name, claude-pod, once:
  - ~/.config/${OLD} (login token, trusted configs) to ~/.config/airlock, and ~/.${OLD} (pod
    session history, package caches) to ~/.airlock; anything already at the new place is kept;
  - keychain secrets from service "${OLD}" to "airlock" (macOS);
  - ${OLD_CONFIG} to ${CONFIG_FILE} in every project you trusted, and in the project you run
    it from (the approval still holds: it is for the file's content, not its name);
  - the shims, if you had them: rewritten for airlock.
It refuses while a claude-pod pod is running. Afterwards: airlock build (the image is new too).`;

// Moves every entry of `from` into `to` that `to` doesn't already have, going one level into
// folders both have (`pods/`), so a launch made before migrating doesn't block the rest. Renames
// never follow a symlink. Returns the paths it had to leave behind.
function merge(from, to, depth = 2) {
  if (kind(from) !== 'dir') return [];
  if (kind(to) === 'missing') {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    return [];
  }
  if (kind(to) !== 'dir' || depth === 0) return [from];
  const left = [];
  for (const name of fs.readdirSync(from)) {
    const src = path.join(from, name);
    const dst = path.join(to, name);
    if (kind(dst) === 'missing') fs.renameSync(src, dst);
    else if (depth > 1 && kind(src) === 'dir' && kind(dst) === 'dir') left.push(...merge(src, dst, depth - 1));
    else left.push(src);
  }
  if (!left.length) fs.rmdirSync(from);
  return left;
}

function trustedRoots() {
  let names = [];
  try {
    names = fs.readdirSync(trustDir()).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const roots = [];
  for (const name of names) {
    try {
      const rec = JSON.parse(readRegularFile(path.join(trustDir(), name)).toString('utf8'));
      if (typeof rec.root === 'string' && path.isAbsolute(rec.root)) roots.push(rec.root);
    } catch {
      // not a record
    }
  }
  return roots;
}

function nearestOldConfig(cwd) {
  let d = fs.realpathSync(cwd);
  for (;;) {
    if (kind(path.join(d, OLD_CONFIG)) !== 'missing') return d;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

const mentionsOld = (file) => {
  try {
    return /claude-pod|CLAUDE_POD/.test(readRegularFile(file).toString('utf8'));
  } catch {
    return false;
  }
};

// Renames one project's config. Only a regular file: the project is pod-writable, and a symlink
// there could point anywhere.
function renameConfig(root, notes) {
  const from = path.join(root, OLD_CONFIG);
  const to = path.join(root, CONFIG_FILE);
  const k = kind(from);
  if (k === 'missing') return false;
  if (k !== 'file') {
    notes.push(`${from} is not a regular file; left as it is.`);
    return false;
  }
  if (kind(to) !== 'missing') {
    notes.push(`${root} has both ${OLD_CONFIG} and ${CONFIG_FILE}; left both. Delete the one you don't want.`);
    return false;
  }
  fs.renameSync(from, to);
  ok(`${clean(root)}: ${OLD_CONFIG} → ${CONFIG_FILE}`);
  if (mentionsOld(to)) notes.push(`${to} mentions claude-pod or CLAUDE_POD_*: change it to airlock / AIRLOCK_*, then run ${bold('airlock trust')} there.`);
  if (mentionsOld(path.join(root, 'package.json'))) notes.push(`${path.join(root, 'package.json')} mentions claude-pod: its scripts need the new command name.`);
  return true;
}

export async function migrate(argv, { cwd = process.cwd() } = {}) {
  const { values } = parseArgs({ args: argv, options: { help: { type: 'boolean', short: 'h' } } });
  if (values.help) {
    process.stdout.write(`${MIGRATE_HELP}\n`);
    return 0;
  }

  // Running pods hold locks, immutable flags and pending records under the old folders.
  let running = '';
  try {
    const res = docker(['ps', '-q', '--filter', `label=${OLD}`]);
    if (res.status === 0) running = res.stdout.trim();
  } catch {
    // no docker on PATH: nothing can be running
  }
  if (running) throw new CliError('A claude-pod pod is still running.', { hint: `Stop it first (${bold('claude-pod stop --all')}, or docker stop), then run this again.` });

  let did = false;
  const notes = [];
  const shimsOnPath = (process.env.PATH || '').split(path.delimiter).some((p) => path.resolve(p) === path.join(oldHostDir(), 'shims'));
  const hadShims = kind(path.join(oldHostDir(), 'shims')) === 'dir';

  // The recorded ID of the old image: the new one gets its own from `airlock build`.
  if (kind(path.join(oldHostDir(), 'image-id')) === 'file') fs.rmSync(path.join(oldHostDir(), 'image-id'));
  for (const [from, to] of [[oldHostDir(), hostDir()], [oldStateRoot(), stateRoot()]]) {
    if (kind(from) === 'missing') continue;
    if (kind(from) !== 'dir') {
      notes.push(`${from} is not a folder; left as it is.`);
      continue;
    }
    const left = merge(from, to);
    did = true;
    if (left.length) {
      warn(`Moved ${from} to ${to}, except what ${to} already had:`);
      for (const l of left) process.stderr.write(`    ${clean(l)}\n`);
    } else {
      ok(`Moved ${from} → ${to}`);
    }
  }

  if (keychainSupported()) {
    const { moved, left } = moveService(OLD);
    if (moved.length) {
      did = true;
      ok(`Moved ${moved.length} keychain secret${moved.length === 1 ? '' : 's'} to service "airlock"`);
    }
    for (const { acct, why } of left) notes.push(`Keychain entry ${OLD}/${acct} not moved: ${why}.`);
  }

  const roots = new Set(trustedRoots());
  const here = nearestOldConfig(cwd);
  if (here) roots.add(here);
  for (const root of [...roots].sort()) if (renameConfig(root, notes)) did = true;

  if (hadShims) {
    // The moved launchers start bin/claude-pod-shim.js, which is gone: write them again. While
    // your shell rc still puts the old folder on PATH, launchers there too keep pnpm & co. going
    // to pods instead of quietly running on the host.
    writeShims();
    if (shimsOnPath) writeShims(path.join(oldHostDir(), 'shims'));
    did = true;
    ok('Rewrote the shims for airlock');
    notes.push(`In your shell rc, replace the claude-pod shims line with:\n    ${pathLine()}${shimsOnPath ? `\n  Then remove ${oldHostDir()}, which holds the stopgap launchers your current PATH still uses.` : ''}`);
  }

  if (!did && !notes.length) {
    ok('Nothing to migrate.');
    return 0;
  }
  for (const n of notes) warn(n);
  info('Next');
  process.stderr.write(`  ${bold('airlock build')}               build the '${IMAGE}' image\n`);
  process.stderr.write(`  ${bold('docker rmi claude-pod')}       free the old image's space\n`);
  process.stderr.write(`  ${bold('npm uninstall -g claude-pod')} remove the old command (then npm install -g . here)\n`);
  return 0;
}
