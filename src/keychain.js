// Project secrets in the macOS login keychain, for `shell` and `exec` pods (never `claude` or
// `run`). Each is a generic password with service `claude-pod` and account `<project key>/<NAME>`,
// where the project key is the name of the project's state dir: one project can never name
// another's secrets, whatever its config says.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { projectStateDir } from './paths.js';
import { CliError } from './ui.js';

export const SERVICE = 'claude-pod';

// Secret names are env names. ANTHROPIC_* is allowed (secrets never reach Claude's own pods, so
// they can't switch it to API billing), but not the names the launcher sets itself: a secret is
// added last and would override them. Keep in step with podEnvFor and buildRunArgs.
const RESERVED = /^(HOME|PATH|CLAUDE_POD(_.*)?|CLAUDE_CONFIG_DIR|CLAUDE_CODE_OAUTH_TOKEN|GIT_CONFIG_GLOBAL|COREPACK_HOME|npm_config_store_dir|npm_config_cache|pnpm_config_store_dir|pnpm_config_cache_dir)$/;

export function secretNameError(name) {
  if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) return 'is not a valid variable name';
  if (RESERVED.test(name)) return 'is set by claude-pod itself';
  return null;
}

// Printable ASCII only: a value goes into the pod's env-file one line per variable, and
// `security -w` prints anything else as hex, which would reach the pod as a different value.
// API keys are ASCII. (A value changed to non-ASCII in Keychain Access still comes back as hex:
// it can't be told from a key that is hex.)
const MAX_VALUE = 1024;
export function secretValueError(value) {
  if (!value) return 'is empty';
  if (!/^[\x20-\x7e]+$/.test(value)) return 'has characters other than printable ASCII (a newline, tab, control or non-ASCII character)';
  if (value.length > MAX_VALUE) return `is longer than ${MAX_VALUE} characters`;
  return null;
}

export const projectKey = (root) => path.basename(projectStateDir(root));

// The account goes unquoted into a `security -i` line, so it must be one plain word.
export function account(root, name) {
  const acct = `${projectKey(root)}/${name}`;
  if (!/^[a-z0-9_][a-z0-9_.-]*\/[A-Za-z_][A-Za-z0-9_]*$/.test(acct)) throw new CliError(`Can't name a keychain entry ${JSON.stringify(acct)}.`);
  return acct;
}

// The one place that runs `security`, by its absolute path: a PATH entry inside the project
// (`.`, node_modules/.bin, direnv) must not be able to supply it. Secrets never go on its
// command line, where `ps` would show them: values in go on stdin, values out come on stdout.
// Tests swap in a fake with useFakeKeychain (test/fixtures/fake-keychain.js).
let runSecurity = (args, input) => spawnSync('/usr/bin/security', args, { encoding: 'utf8', input, env: process.env, maxBuffer: 64 * 1024 * 1024 });
let platform = process.platform;

export function useFakeKeychain({ run, platform: p }) {
  runSecurity = run;
  if (p) platform = p;
}

export const supported = () => platform === 'darwin';

export function assertSupported() {
  if (!supported()) throw new CliError('keychain secrets are macOS-only for now.');
}

function security(args, input) {
  const res = runSecurity(args, input);
  if (res.error) throw new CliError(`Could not run security: ${res.error.message}`);
  return res;
}

// 44 is errSecItemNotFound. Anything else (a locked keychain over SSH, a denied access prompt) is
// an error, not "missing".
const NOT_FOUND = 44;
function failed(what, res) {
  return new CliError(`Could not ${what} in the keychain: ${res.stderr.trim() || `security exited ${res.status}`}`);
}

// The value, or null when there is no such entry.
export function getSecret(root, name) {
  const res = security(['find-generic-password', '-s', SERVICE, '-a', account(root, name), '-w']);
  if (res.status === NOT_FOUND) return null;
  if (res.status !== 0) throw failed(`read ${name}`, res);
  return res.stdout.replace(/\n$/, '');
}

// Whether an entry exists, without reading its value.
export function hasSecret(root, name) {
  const res = security(['find-generic-password', '-s', SERVICE, '-a', account(root, name)]);
  if (res.status === NOT_FOUND) return false;
  if (res.status !== 0) throw failed(`look up ${name}`, res);
  return true;
}

// `security add-generic-password -w` with no value prompts on the terminal, which we can't feed.
// So the command goes to `security -i` on stdin instead, with the value hex-encoded (-X): no
// quoting to get wrong, and nothing on any command line. `-i` exits with the last command's
// status, and we read the value back anyway to be sure it landed.
export function setSecret(root, name, value) {
  const hex = Buffer.from(value, 'utf8').toString('hex');
  const res = security(['-i'], `add-generic-password -U -s ${SERVICE} -a ${account(root, name)} -X ${hex}\n`);
  if (res.status !== 0) throw failed(`store ${name}`, res);
  if (getSecret(root, name) !== value) throw new CliError(`Stored ${name}, but reading it back gave a different value.`);
}

// True when something was removed, false when there was nothing to remove.
export function removeSecret(root, name) {
  const res = security(['delete-generic-password', '-s', SERVICE, '-a', account(root, name)]);
  if (res.status === NOT_FOUND) return false;
  if (res.status !== 0) throw failed(`remove ${name}`, res);
  return true;
}

// Every claude-pod account in the keychain dump, from attributes only (`dump-keychain` without
// -d never prints values or asks for access). Items are separated by `keychain: "…"` lines.
export function parseDump(text) {
  const accounts = [];
  for (const item of text.split(/^keychain: /m)) {
    const svce = item.match(/^\s*"svce"<blob>="(.*)"$/m)?.[1];
    const acct = item.match(/^\s*"acct"<blob>="(.*)"$/m)?.[1];
    if (svce === SERVICE && acct) accounts.push(acct);
  }
  return accounts;
}

function dump() {
  const res = security(['dump-keychain']);
  if (res.status !== 0) throw failed('list secrets', res);
  return parseDump(res.stdout);
}

// This project's secret names.
export function listSecrets(root) {
  const prefix = `${projectKey(root)}/`;
  const names = dump().filter((a) => a.startsWith(prefix)).map((a) => a.slice(prefix.length));
  return [...new Set(names.filter((n) => !secretNameError(n)))].sort();
}

// Every project's entries, as `<project key>/<NAME>`: finds secrets a moved or renamed project left.
export const listAllSecrets = () => [...new Set(dump())].sort();
