import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_FILE, hostDir, sha256, trustDir } from './paths.js';
import { parseDotenv } from './dotenv.js';
import { secretNameError } from './keychain.js';
import { readOnlyPath, runningReadOnly } from './protect.js';
import { ensurePrivateDir, isInside, kind, readRegularFile, writeFileAtomic } from './safefs.js';
import { CliError } from './ui.js';

// SECURITY: airlock.config.json lives in the project, which every pod can write. So a config
// is only honoured once you have approved its exact bytes (see isTrusted), and even then it is
// validated to keep the pod's isolation intact: bridge-type networks only, an envFile inside the
// project, no host environment variables, no reserved env names, readOnly paths inside the project.
// `secrets` only names keychain entries; which project's entries is never up to the config.

// Walks up from `start` looking for a directory that satisfies `test`. Returns it, or null.
function findUp(start, test) {
  let dir = start;
  for (;;) {
    if (test(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Resolves which folder gets mounted into the pod. Agents launch from the project root, from a
// subfolder, after a `cd`, or not — so we never trust the cwd alone:
//   1. the nearest ancestor with a airlock.config.json (explicit opt-in wins),
//   2. else the nearest git root (`.git` dir, or file for worktrees/submodules),
//   3. else the cwd itself (rejected later by assertSafeRoot unless it's a project).
export function findProjectRoot(cwd = process.cwd()) {
  // .native spells each part as on disk: on macOS `MyApp` and `myapp` are one project, and must
  // share one trust record, one state dir and one set of locks.
  const real = fs.realpathSync.native(cwd);
  const withConfig = findUp(real, (d) => kind(path.join(d, CONFIG_FILE)) !== 'missing');
  if (withConfig) return { root: withConfig, configPath: path.join(withConfig, CONFIG_FILE) };
  const gitRoot = findUp(real, (d) => kind(path.join(d, '.git')) !== 'missing');
  return { root: gitRoot || real, configPath: null };
}

// Folders whose presence means "this is a home directory, not a project".
const HOME_MARKERS = ['.ssh', '.aws', '.gnupg'];

// Refuses to mount anything that would hand the pod more than one project: /, your home, any
// ancestor of your home, a home-like folder, or a folder that isn't a project at all (no .git
// and no airlock.config.json — e.g. ~/Documents holding many projects).
export function assertSafeRoot(root, { requireProject = true } = {}) {
  const real = fs.realpathSync(root);
  const home = fs.realpathSync(os.homedir());
  const refuse = (why) => new CliError(`Refusing to mount ${real} into the pod: ${why}.`, {
    hint: 'cd into a project folder first (a git repo, or run `airlock init` in it).',
  });
  if (real === path.parse(real).root) throw refuse('it is the filesystem root');
  if (isInside(home, real)) throw refuse(real === home ? 'it is your home directory' : 'it contains your home directory');
  const marker = HOME_MARKERS.find((m) => kind(path.join(real, m)) !== 'missing');
  if (marker) throw refuse(`it contains ${marker}, so it looks like a home directory`);
  if (requireProject && kind(path.join(real, '.git')) === 'missing' && kind(path.join(real, CONFIG_FILE)) === 'missing') {
    throw refuse('it is not a git repository and has no airlock.config.json');
  }
}

const KNOWN_KEYS = new Set(['network', 'ports', 'envFile', 'env', 'resources', 'readOnly', 'secrets', 'shims']);

// Env names the launcher sets itself, or that would change how Claude authenticates/stores state.
const RESERVED_ENV = /^(HOME|AIRLOCK(_.*)?|CLAUDE_CONFIG_DIR|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_.*)$/;

// Docker network names; excludes `host`, `container:<id>` and anything else with special meaning.
// The driver is checked against Docker at launch (assertNetwork).
const NETWORK_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export const MEMORY_RE = /^[1-9][0-9]*(\.[0-9]+)?[bkmg]?$/i;
export const CPUS_RE = /^(0?\.[0-9]*[1-9][0-9]*|[1-9][0-9]*(\.[0-9]+)?)$/;

export function validateResources(r, where) {
  const bad = (msg) => new CliError(`${where}: ${msg}`);
  if (r.pids !== undefined && !(Number.isInteger(Number(r.pids)) && Number(r.pids) >= 16)) {
    throw bad('pids must be an integer ≥ 16.');
  }
  if (r.memory !== undefined && !MEMORY_RE.test(String(r.memory))) {
    throw bad('memory must look like 512m, 4g or a byte count (not 0).');
  }
  if (r.cpus !== undefined && !CPUS_RE.test(String(r.cpus))) throw bad('cpus must be a positive number, e.g. 2 or 0.5.');
}

const isPort = (p) => Number.isInteger(p) && p >= 1 && p <= 65535;

// A "ports" entry is a container port (published on a free host port), or
// {"port": 3000, "fixed": true} for a dev server that must keep its real port: OAuth callbacks,
// auth base URLs and cookies are set to it. Returns { port, fixed } or { error }.
function portEntry(p) {
  if (typeof p === 'number') return isPort(p) ? { port: p, fixed: false } : { error: 'is not a port number (1-65535)' };
  if (p === null || typeof p !== 'object' || Array.isArray(p)) return { error: 'must be a port number or {"port": N, "fixed": true}' };
  const extra = Object.keys(p).find((k) => k !== 'port' && k !== 'fixed');
  if (extra) return { error: `has unknown key "${extra}"` };
  if (!isPort(p.port)) return { error: 'needs "port": a port number (1-65535)' };
  if (p.fixed !== undefined && typeof p.fixed !== 'boolean') return { error: 'has a "fixed" that is not true or false' };
  return { port: p.port, fixed: p.fixed === true };
}

function validate(raw, file) {
  const bad = (msg) => new CliError(`${file}: ${msg}`);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw bad('must be a JSON object.');
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key) && !key.startsWith('$')) throw bad(`unknown key "${key}".`);
  }
  if (raw.network !== undefined) {
    if (typeof raw.network !== 'string' || !NETWORK_NAME.test(raw.network) || raw.network === 'host') {
      throw bad('"network" must be "none" or the name of a bridge network (not "host" or "container:…").');
    }
  }
  if (raw.ports !== undefined) {
    if (!Array.isArray(raw.ports)) throw bad('"ports" must be an array of container ports.');
    const seen = new Set();
    for (const p of raw.ports) {
      const { port, error } = portEntry(p);
      if (error) throw bad(`"ports" entry ${JSON.stringify(p)} ${error}.`);
      if (seen.has(port)) throw bad(`"ports" has ${port} twice.`);
      seen.add(port);
    }
  }
  if (raw.envFile !== undefined && (typeof raw.envFile !== 'string' || !raw.envFile || path.isAbsolute(raw.envFile))) {
    throw bad('"envFile" must be a path relative to the project.');
  }
  if (raw.env !== undefined) {
    if (raw.env === null || typeof raw.env !== 'object' || Array.isArray(raw.env)) throw bad('"env" must be an object.');
    for (const [k, v] of Object.entries(raw.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw bad(`"env" key "${k}" is not a valid variable name.`);
      if (RESERVED_ENV.test(k)) throw bad(`"env.${k}" is reserved by airlock.`);
      if (typeof v !== 'string') throw bad(`"env.${k}" must be a string.`);
    }
  }
  if (raw.resources !== undefined) {
    const r = raw.resources;
    if (r === null || typeof r !== 'object' || Array.isArray(r)) throw bad('"resources" must be an object.');
    for (const key of Object.keys(r)) {
      if (!['pids', 'memory', 'cpus'].includes(key)) throw bad(`unknown "resources" key "${key}".`);
    }
    validateResources(r, `${file} "resources"`);
  }
  if (raw.readOnly !== undefined) {
    if (!Array.isArray(raw.readOnly)) throw bad('"readOnly" must be an array of paths relative to the project.');
    const seen = new Set();
    for (const p of raw.readOnly) {
      const { rel, error } = readOnlyPath(p);
      if (error) throw bad(`"readOnly" entry ${JSON.stringify(p)} ${error}.`);
      if (seen.has(rel)) throw bad(`"readOnly" has ${rel} twice.`);
      seen.add(rel);
    }
  }
  if (raw.secrets !== undefined) {
    if (!Array.isArray(raw.secrets)) throw bad('"secrets" must be an array of variable names.');
    for (const name of raw.secrets) {
      const error = secretNameError(name);
      if (error) throw bad(`"secrets" entry ${JSON.stringify(name)} ${error}.`);
      if (Object.hasOwn(raw.env || {}, name)) throw bad(`"${name}" is in both "env" and "secrets".`);
    }
    if (new Set(raw.secrets).size !== raw.secrets.length) throw bad('"secrets" has duplicates.');
  }
  if (raw.shims !== undefined) {
    const sh = raw.shims;
    if (sh === null || typeof sh !== 'object' || Array.isArray(sh)) throw bad('"shims" must be an object, e.g. {"host": ["dev"]}.');
    for (const key of Object.keys(sh)) if (key !== 'host') throw bad(`unknown "shims" key "${key}".`);
    if (sh.host !== undefined) {
      if (!Array.isArray(sh.host)) throw bad('"shims.host" must be an array of package script names.');
      for (const name of sh.host) {
        if (typeof name !== 'string' || !/^[^\s\0-]\S*$/.test(name)) throw bad(`"shims.host" entry ${JSON.stringify(name)} is not a script name.`);
      }
    }
  }
  return raw;
}

// Replaces ${VAR} with a value from `vars` (the envFile only — never the host environment, which
// would let a pod-written config pull host secrets into the next pod); `$$` is a literal `$`.
// Unknown variables are an error, so a missing secret fails here instead of as a DB error.
export function interpolate(template, vars, where) {
  const out = template.replace(/\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name) => {
    if (match === '$$') return '$';
    if (!Object.hasOwn(vars, name)) throw new CliError(`${where} references \${${name}}, which is not set in the envFile.`);
    return vars[name];
  });
  if (/[\n\r\0]/.test(out)) throw new CliError(`${where} contains a newline or NUL, which can't be passed to the pod.`);
  return out;
}

// Reads the envFile, which must resolve (after symlinks) to a regular file inside the project.
function readEnvFile(root, rel) {
  const envPath = path.resolve(root, rel);
  if (kind(envPath) === 'missing') {
    throw new CliError(`envFile ${envPath} not found.`, { hint: 'Create it (e.g. from .env.example) or remove "envFile" from the config.' });
  }
  const real = fs.realpathSync(envPath);
  if (!isInside(real, root)) throw new CliError(`envFile ${rel} resolves outside the project (${real}). Refusing to read it.`);
  return parseDotenv(readRegularFile(real).toString('utf8'));
}

// Loads and resolves the project's config. With no config file, returns the empty defaults.
// `hash` is the sha256 of the exact bytes, for the trust check.
export function loadConfig({ root, configPath }) {
  const empty = { network: null, ports: [], env: {}, resources: {}, readOnly: [], secrets: [], shims: null, file: null, hash: null, text: null };
  if (!configPath) return empty;

  let bytes;
  let raw;
  try {
    bytes = readRegularFile(configPath, 64 * 1024);
    raw = JSON.parse(bytes.toString('utf8'));
  } catch (e) {
    if (e instanceof CliError) throw e;
    throw new CliError(`Could not read ${configPath}: ${e.message}`);
  }
  validate(raw, CONFIG_FILE);

  const vars = raw.envFile ? readEnvFile(root, raw.envFile) : {};
  const env = {};
  for (const [k, v] of Object.entries(raw.env || {})) env[k] = interpolate(v, vars, `${CONFIG_FILE} "env.${k}"`);

  return {
    network: raw.network || null,
    ports: (raw.ports || []).map(portEntry),
    env,
    resources: raw.resources || {},
    readOnly: (raw.readOnly || []).map((p) => readOnlyPath(p).rel),
    secrets: raw.secrets || [],
    // null: the project didn't opt in to shims; otherwise the scripts that stay on the host.
    shims: raw.shims ? { host: raw.shims.host || [] } : null,
    file: configPath,
    hash: sha256(bytes),
    text: bytes.toString('utf8'),
  };
}

// ── Trust records ─────────────────────────────────────────────────────────────────────────────
// Stored host-only (~/.config/airlock/trust/), keyed by project path: the sha256 of the config
// bytes you approved. Any change — by you or by a pod — needs approving again.

const trustFile = (root) => path.join(trustDir(), `${sha256(root)}.json`);

function trustRecord(root) {
  try {
    const rec = JSON.parse(readRegularFile(trustFile(root)).toString('utf8'));
    return rec.root === root ? rec : null;
  } catch {
    return null;
  }
}

export function isTrusted(root, hash) {
  return trustRecord(root)?.sha256 === hash;
}

const fold = (x) => (process.platform === 'darwin' ? x.normalize('NFC').toLowerCase() : x);

// A fingerprint of a `readOnly` path's content: a file, a folder (recursively, never following a
// symlink), a symlink's target, or "missing". null when it is too big to check.
const TOO_BIG = Symbol('too big');
export function fingerprint(p) {
  const h = crypto.createHash('sha256');
  let entries = 0;
  let bytes = 0;
  const walk = (q, rel) => {
    if (++entries > 20_000) throw TOO_BIG;
    const k = kind(q);
    h.update(`${rel}\0${k}\0`);
    if (k === 'file') {
      const data = fs.readFileSync(q);
      bytes += data.length;
      if (bytes > 256 * 1024 * 1024) throw TOO_BIG;
      h.update(sha256(data));
    } else if (k === 'dir') {
      for (const name of fs.readdirSync(q).sort()) walk(path.join(q, name), `${rel}/${name}`);
    } else if (k === 'symlink') {
      h.update(fs.readlinkSync(q));
    }
    h.update('\0');
  };
  try {
    walk(p, '.');
  } catch (e) {
    if (e === TOO_BIG) return null;
    throw e;
  }
  return h.digest('hex');
}

const writeRecord = (root, rec) => writeFileAtomic(trustFile(root), `${JSON.stringify(rec, null, 2)}\n`);

// `shims` records whether the approved config had "shims". A pod can delete that key, or the
// whole config, and the host shims must not then quietly run commands on the host: they check
// this host-only record instead (see shim.js).
// `readOnly` is the config's list. A path in it that a pod of this project still running doesn't
// have locked (it started under an older config) can change after this approval, until that pod
// exits: its fingerprint now goes into `watch`, and the shims refuse it if it no longer matches
// (see readOnlyChanged). One already watched keeps the fingerprint you last approved, under any
// spelling and even while it is out of the list: only checking it, or your approval, settles it.
// `readOnly` is also kept, so the next approval can say which paths are new (newReadOnly).
export function trust(root, hash, { shims = false, readOnly = [] } = {}) {
  ensurePrivateDir(trustDir());
  const prev = trustRecord(root);
  const running = runningReadOnly(root);
  const watch = { ...(prev?.watch ?? {}) };
  for (const rel of readOnly) {
    const key = fold(rel);
    if (Object.hasOwn(watch, key)) continue;
    if (!running.every((list) => list.some((r) => fold(r) === key))) watch[key] = fingerprint(path.join(root, rel));
  }
  writeRecord(root, { root, sha256: hash, shims, readOnly, watch, trustedAt: new Date().toISOString() });
  writeShimsIndex();
}

// The config's `readOnly` paths that the one you last approved didn't have: approving it approves
// their content as it is now, whoever wrote it.
export function newReadOnly(root, config) {
  const before = trustRecord(root)?.readOnly;
  if (!Array.isArray(before)) return config.readOnly;
  const had = new Set(before.filter((r) => typeof r === 'string').map(fold));
  return config.readOnly.filter((rel) => !had.has(fold(rel)));
}

// Whether `rel` (a "readOnly" entry) changed after you approved the config, while a pod that didn't
// have it locked was running. The caller has checked that no such pod runs any more: a path that
// still matches is then settled, and stops being watched.
export function readOnlyChanged(root, rel) {
  const rec = trustRecord(root);
  const key = fold(rel);
  if (!rec?.watch || !Object.hasOwn(rec.watch, key)) return false;
  const now = fingerprint(path.join(root, rel));
  if (now === null || now !== rec.watch[key]) return true;
  const { [key]: _settled, ...watch } = rec.watch;
  writeRecord(root, { ...rec, watch });
  return false;
}

// The watched "readOnly" entries that no longer match what you approved, for `airlock trust`.
export function changedReadOnly(root, readOnly) {
  const watch = trustRecord(root)?.watch ?? {};
  return readOnly.filter((rel) => {
    const key = fold(rel);
    return Object.hasOwn(watch, key) && (watch[key] === null || fingerprint(path.join(root, rel)) !== watch[key]);
  });
}

// You reviewed them: their current content is what you approve. Still watched while a pod that
// can write them runs. One too big to fingerprint can't be watched: your approval settles it.
export function approveReadOnly(root, rels) {
  const rec = trustRecord(root);
  const watch = { ...(rec.watch ?? {}) };
  for (const rel of rels) {
    const now = fingerprint(path.join(root, rel));
    if (now === null) delete watch[fold(rel)];
    else watch[fold(rel)] = now;
  }
  writeRecord(root, { ...rec, watch });
}

export const optedIntoShims = (root) => trustRecord(root)?.shims === true;

// The roots of opted-in projects, one per line, for the launchers' fast path (shims.js): a command
// with none of these, and no config, above the current folder runs without starting node.
export const shimsIndexPath = () => path.join(hostDir(), 'shims-opted');
export function writeShimsIndex() {
  // Twice when they differ: an approval written meanwhile (another `trust`) must not be lost,
  // which would let the fast path miss its project.
  ensurePrivateDir(hostDir());
  for (let i = 0; i < 5; i++) {
    const roots = optedRoots();
    writeFileAtomic(shimsIndexPath(), roots.map((r) => `${r}\n`).join(''));
    if (optedRoots().join('\n') === roots.join('\n')) return;
  }
}

function optedRoots() {
  let names = [];
  try {
    names = fs.readdirSync(trustDir()).filter((f) => f.endsWith('.json')).sort();
  } catch {
    // no approvals yet
  }
  const roots = [];
  for (const name of names) {
    try {
      const rec = JSON.parse(readRegularFile(path.join(trustDir(), name)).toString('utf8'));
      if (rec.shims === true && typeof rec.root === 'string' && path.isAbsolute(rec.root) && !/[\n\r]/.test(rec.root)) roots.push(rec.root);
    } catch {
      // not a record
    }
  }
  return roots;
}

// Said before approving a config: one without "shims" in a project that had them turns them off,
// and a pod may be the one that removed the key.
export function shimsOffWarning(root, config) {
  if (config.shims) return null;
  // This project, or one it is inside: a pod of the outer project can plant this config.
  let d = root;
  while (!optedIntoShims(d) && path.dirname(d) !== d) d = path.dirname(d);
  if (!optedIntoShims(d)) return null;
  return d === root
    ? 'This config has no "shims", and the one you approved had. Approving it runs pnpm, npm, node & co. on the host again in this project. A pod may have removed the key.'
    : `This config has no "shims", and it is inside ${d}, which has them. Approving it runs pnpm, npm, node & co. on the host in this folder. A pod of ${d} may have planted it.`;
}

// For `airlock shims --forget`: the project removed its config or "shims" on purpose.
export function forgetShims(root) {
  const rec = trustRecord(root);
  if (!rec?.shims) return false;
  writeRecord(root, { ...rec, shims: false });
  writeShimsIndex();
  return true;
}
