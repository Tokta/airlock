// Host shims: `pnpm`, `node` & co. typed on the host (by a person or the host Claude session) run in
// a pod when the project opted in. The shell launchers `claude-pod shims` writes call shimMain
// after taking the shims folder (and relative entries) off PATH, so everything here sees the real
// binaries.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isTrusted, loadConfig, optedIntoShims } from './config.js';
import { launch } from './launch.js';
import { CONFIG_FILE, hostDir } from './paths.js';
import { LOCKED, maybePlanted, runningReadOnly } from './protect.js';
import { isInside, kind, readRegularFile } from './safefs.js';
import { CliError, bold, clean, err } from './ui.js';

export const SHIM_TOOLS = ['pnpm', 'npm', 'npx', 'node', 'tsx', 'yarn', 'bunx', 'bun'];
export const shimsDir = () => path.join(hostDir(), 'shims');

const hasConfig = (d) => kind(path.join(d, CONFIG_FILE)) !== 'missing';
const fold = (x) => (process.platform === 'darwin' ? x.normalize('NFC').toLowerCase() : x);
export const sq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

// The nearest folder at or above `dir` that passes `test`, or null.
function findUp(dir, test) {
  for (;;) {
    if (test(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// pnpm's own commands: `pnpm <name>` runs one of these, not the script of that name. (`test` and
// `start` run the script.)
const PNPM_COMMANDS = new Set(['add', 'i', 'install', 'ln', 'link', 'prune', 'rb', 'rebuild', 'rm', 'remove', 'uninstall',
  'un', 'unlink', 'up', 'update', 'upgrade', 'audit', 'licenses', 'list', 'ls', 'll', 'la', 'outdated', 'why', 'dlx', 'exec',
  'create', 'init', 'pack', 'publish', 'deploy', 'store', 'root', 'bin', 'setup', 'server', 'env', 'config', 'c', 'get', 'set',
  'doctor', 'import', 'fetch', 'patch', 'patch-commit', 'patch-remove', 'recursive', 'multi', 'm', 'dedupe', 'approve-builds',
  'ignored-builds', 'self-update', 'cat-file', 'cat-index', 'find-hash', 'help', 'restart', 'stop', 'x', 'run', 'run-script']);
// npm's commands that run a script of another name.
const NPM_ALIASES = { start: 'start', stop: 'stop', test: 'test', t: 'test', tst: 'test' };

// The package script a command asks for, when it is one of shims.host, or null:
//   pnpm <name> | pnpm run <name> | npm run <name> | npm start|stop|test
// each optionally followed by `-- <args>`. Anything else (a flag first, args not after `--`,
// pnpm's own commands) is not a host script.
export function hostScript(tool, args, host) {
  let name;
  let rest;
  if (tool === 'pnpm') {
    if (args[0] === 'run' || args[0] === 'run-script') [name, ...rest] = args.slice(1);
    else if (!PNPM_COMMANDS.has(args[0])) [name, ...rest] = args;
  } else if (tool === 'npm') {
    if (args[0] === 'run' || args[0] === 'run-script') [name, ...rest] = args.slice(1);
    else if (Object.hasOwn(NPM_ALIASES, args[0] ?? '')) [name, ...rest] = [NPM_ALIASES[args[0]], ...args.slice(1)];
  }
  if (typeof name !== 'string' || !host.includes(name)) return null;
  if (rest.length && rest[0] !== '--') return null;
  return { name, extra: rest.slice(1) };
}

// The project that decides for a command started in `start` (a real folder): { root, config } when
// it opted in, null when the command runs on the host as usual, or a CliError when it must not run
// at all. Only projects that opted in are affected: the nearest claude-pod.config.json with "shims"
// (config only, not the git root). A project whose approved config had "shims" stays opted in even
// if a pod deletes the key or the whole config.
function shimProject(tool, start) {
  const root = findUp(start, hasConfig);
  const opted = findUp(start, optedIntoShims);
  // The opted-in project's own config is gone (a nearer or farther one doesn't count).
  if (opted && root !== opted && (!root || isInside(opted, root))) {
    throw new CliError(`${CONFIG_FILE} in ${opted} is gone, and it had "shims", so ${tool} doesn't run.`, {
      hint: 'Restore it (a pod may have deleted it). If you removed it on purpose, see claude-pod shims --help.',
    });
  }
  if (!root) return null;
  const configPath = path.join(root, CONFIG_FILE);
  let config;
  try {
    // Only the "shims" key decides whether this project opted in, so a config that is otherwise
    // broken (a missing envFile, say) doesn't stop pnpm in a project that never opted in.
    const raw = JSON.parse(readRegularFile(configPath, 64 * 1024)?.toString('utf8') ?? '{}');
    // Inside an opted-in project, a nearer config (one a pod could plant in a subfolder) must be
    // trusted before it can turn the shims off.
    if ((raw === null || typeof raw !== 'object' || raw.shims === undefined) && !opted) return null;
    config = loadConfig({ root, configPath });
  } catch (e) {
    // A config we can't read might be one that opted in: never fall back to the host for it.
    throw new CliError(`${CONFIG_FILE} in ${root} can't be read, so ${tool} doesn't run: ${e.message}`);
  }
  if (!isTrusted(root, config.hash)) {
    throw new CliError(`${config.file} is new or has changed since you approved it, so ${tool} doesn't run.`, {
      hint: `Review it (a pod can edit it), then run ${bold('claude-pod trust')}. Shimmed commands never run on the host instead.`,
    });
  }
  // Trusted without "shims": you approved turning them off.
  return config.shims ? { root, config } : null;
}

// `rel` under `root` as a real path, or null when it is missing or reached through a symlink
// (a locked path never is: protectedMounts refuses to start a pod then).
function realEntry(root, rel) {
  try {
    const real = fs.realpathSync.native(path.join(root, rel));
    return fold(path.relative(root, real).split(path.sep).join('/')) === fold(rel) ? real : null;
  } catch {
    return null;
  }
}

// Whether a config `readOnly` entry is locked for every pod of the project that may be running: a
// pod started under an older config, which didn't list it, can still write it.
function lockedForAllRuns(root, rel) {
  return runningReadOnly(root).every((list) => list.some((r) => fold(r) === fold(rel)));
}

// Whether a real path inside the project is one no pod can write: under a "readOnly" entry (locked
// for every running pod too) or a path claude-pod always locks (.claude/, .git/hooks, …), and not
// created by a pod that is running.
export function podProof(root, config, real) {
  if (maybePlanted(root, real)) return false;
  const covers = (rel) => {
    const entry = realEntry(root, rel);
    return entry !== null && isInside(real, entry);
  };
  return LOCKED.some((l) => covers(l.rel)) || config.readOnly.some((rel) => covers(rel) && lockedForAllRuns(root, rel));
}

// The root of the opted-in project in which a pod could write `p` (not podProof), or null.
// Refuses (throws) like shimProject.
function podWritableIn(p) {
  const real = path.join(fs.realpathSync.native(path.dirname(p)), path.basename(p));
  const project = shimProject('node', path.dirname(real));
  return project !== null && !podProof(project.root, project.config, real) ? project.root : null;
}

// `node <file> …`: { real, linkRoot } for the file, or null for bare `node`, `node -e`, options
// before the file (`node --require x file`), `node inspect`, or a file that doesn't exist as given.
// Scripts started by their `#!/usr/bin/env node` line always come as `node <file> …`.
// Every symlink on the way is checked too: one a pod wrote (`build.js -> ~/tools/cli.js`) sends the
// command to the pod, never to whatever it points at on the host.
function nodeScript(args, cwd) {
  const [first] = args;
  if (!first || first.startsWith('-') || first === 'inspect') return null;
  // Resolved one link at a time, as the kernel does, so a link inside a link's target (an
  // `npm link`ed package whose bin a pod replaced with a link) is checked too. `cur` never
  // contains a symlink, so `..` in a target is applied to the real folder.
  let cur = path.sep;
  let linkRoot = null; // the project of the first pod-writable symlink on the way
  let parts = path.resolve(cwd, first).split(path.sep);
  let hops = 0;
  try {
    while (parts.length) {
      const part = parts.shift();
      if (part === '' || part === '.') continue;
      if (part === '..') {
        cur = path.dirname(cur);
        continue;
      }
      const next = path.join(cur, part);
      if (kind(next) !== 'symlink') {
        cur = next;
        continue;
      }
      if (++hops > 40) return null; // a loop: node would fail anyway
      linkRoot ??= podWritableIn(next);
      const target = fs.readlinkSync(next);
      if (path.isAbsolute(target)) cur = path.sep;
      parts = [...target.split(path.sep), ...parts];
    }
    cur = fs.realpathSync.native(cur);
    if (!fs.statSync(cur).isFile()) return null;
  } catch (e) {
    if (e instanceof CliError) throw e;
    return null;
  }
  return { real: cur, linkRoot };
}

// Arguments of a `node` command that name something in an opted-in project (a file, the same
// without its extension, a folder): the project's root, or null. For the forms nodeScript doesn't
// decide, so that they go to the pod even when started from outside the project.
function nodeProjectArg(args, cwd) {
  for (const a of args) {
    if (a.startsWith('-')) continue;
    for (const ext of ['', '.js', '.mjs', '.cjs']) {
      let real;
      try {
        real = fs.realpathSync.native(path.resolve(cwd, a + ext));
      } catch {
        continue;
      }
      const project = shimProject('node', fs.statSync(real).isDirectory() ? real : path.dirname(real));
      if (project) return project.root;
    }
  }
  return null;
}

// The host script for `hs` in the project, or null when it goes to the pod: the nearest
// package.json is not the project's own (a workspace package), or it has no such script. Refuses
// when a pod could have written the script: package.json must be under "readOnly".
function readHostScript(root, config, hs, cwd) {
  if (findUp(cwd, (d) => d === root || kind(path.join(d, 'package.json')) !== 'missing') !== root) return null;
  const file = path.join(root, 'package.json');
  const listed = config.readOnly.some((rel) => fold(rel) === 'package.json');
  if (!listed || kind(file) !== 'file' || !podProof(root, config, realEntry(root, 'package.json') ?? file)) {
    throw new CliError(`"${hs.name}" is in shims.host, but ${file} is not read-only for every pod of the project, so a pod could have written it.`, {
      hint: `Add "package.json" to "readOnly" in ${CONFIG_FILE} (and the files the script runs), then ${bold('claude-pod trust')}. A pod started before that can write it until it exits: review the file (git diff) after it has, before running the script.`,
    });
  }
  let scripts;
  try {
    scripts = JSON.parse(readRegularFile(file, 1024 * 1024).toString('utf8')).scripts;
  } catch (e) {
    throw new CliError(`${file} can't be read: ${e.message}`);
  }
  const script = scripts !== null && typeof scripts === 'object' && Object.hasOwn(scripts, hs.name) ? scripts[hs.name] : undefined;
  return typeof script === 'string' ? script : null;
}

// The pod's starting folder for a project: the cwd when it is in that project, else its root.
const podCwd = (realCwd, root) => (findUp(realCwd, hasConfig) === root ? realCwd : root);

// Where a shimmed command goes:
//   { to: 'host', args }                         the real binary, with these args
//   { to: 'script', root, name, script, extra }  a shims.host script, run by claude-pod with /bin/sh
//   { to: 'pod', cwd }                           `claude-pod exec --no-ports` from `cwd`
// or throws a CliError when it must not run at all.
// `node <file>` is decided by where <file> is: in an opted-in project and writable by a pod → the
// pod; anywhere else (a global CLI, claude-pod itself, a locked script) → the host, which runs the
// real path checked here (so a symlink flipped in between changes nothing).
export function route(tool, args, cwd) {
  let realCwd;
  try {
    realCwd = fs.realpathSync.native(cwd);
  } catch (e) {
    throw new CliError(`the current folder can't be read (${e.code}).`);
  }
  if (tool === 'node') {
    const script = nodeScript(args, realCwd);
    if (script) {
      const project = shimProject(tool, path.dirname(script.real));
      if (!script.linkRoot && (!project || podProof(project.root, project.config, script.real))) {
        return { to: 'host', args: [script.real, ...args.slice(1)] };
      }
      return { to: 'pod', cwd: podCwd(realCwd, script.linkRoot ?? project.root) };
    }
    const root = nodeProjectArg(args, realCwd);
    if (root) return { to: 'pod', cwd: podCwd(realCwd, root) };
  }
  const project = shimProject(tool, realCwd);
  if (!project) return { to: 'host', args };
  const hs = hostScript(tool, args, project.config.shims.host);
  if (hs) {
    const script = readHostScript(project.root, project.config, hs, realCwd);
    if (script !== null) return { to: 'script', root: project.root, name: hs.name, script, extra: hs.extra };
  }
  return { to: 'pod', cwd: realCwd };
}

// The real `tool`: the first on PATH (already without the shims folder, see the launcher) that
// isn't the shims folder under another spelling (a symlink to it), which would start this shim
// again, forever.
function realBinary(tool) {
  let shims;
  try {
    shims = fs.realpathSync.native(shimsDir());
  } catch {
    shims = shimsDir();
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    try {
      if (fs.realpathSync.native(dir) === shims) continue;
      const p = path.join(dir, tool);
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) return p;
    } catch {
      // not here
    }
  }
  throw new CliError(`${tool} not found on PATH after the claude-pod shims.`);
}

// The PATH to hand to what runs on the host: the one you started with, shims included (so a
// `pnpm build` that a host tool starts in an opted-in project still goes to a pod), minus relative
// entries (`node_modules/.bin`), which a pod can fill.
const hostPath = (shimPath) => (shimPath ?? process.env.PATH ?? '').split(path.delimiter).filter((d) => path.isAbsolute(d)).join(path.delimiter);

// Runs a child with our stdio and resolves to { code, signal }. Signals sent to the shim are passed
// on, except SIGINT from a terminal: Ctrl-C reaches the child directly (it is in our process
// group), and many tools take a second one as "force quit". With no terminal on stdin, SIGINT was
// sent to the shim alone (a test runner, `child.kill('SIGINT')`), so it is passed on too.
// `ipcFd`: the IPC channel a parent opened for `node` (see the launcher), passed on as itself.
function runChild(cmd, args, { ipcFd = null, ...opts } = {}) {
  return new Promise((resolve, reject) => {
    const stdio = ['inherit', 'inherit', 'inherit'];
    if (ipcFd !== null) {
      for (let fd = 3; fd < ipcFd; fd++) stdio.push('ignore');
      stdio.push(ipcFd);
    }
    const child = spawn(cmd, args, { stdio, ...opts });
    const forward = (sig) => child.kill(sig);
    const onInt = () => {
      if (!process.stdin.isTTY) child.kill('SIGINT');
    };
    const sigs = ['SIGTERM', 'SIGHUP'];
    for (const sig of sigs) process.on(sig, forward);
    process.on('SIGINT', onInt);
    const done = () => {
      for (const sig of sigs) process.removeListener(sig, forward);
      process.removeListener('SIGINT', onInt);
    };
    child.on('error', (e) => {
      done();
      reject(e);
    });
    child.on('exit', (code, signal) => {
      done();
      resolve({ code, signal });
    });
  });
}

// The exit code for `shimMain`, or { signal } when the child was killed by one: the launcher's
// node then dies by the same signal (see bin/claude-pod-shim.js), as the real command would have.
const outcome = ({ code, signal }) => (signal ? { signal } : code);

export async function shimMain(tool, args) {
  // Set by the launcher: the PATH it was started with, a parent's IPC fd for `node`, and a flag
  // that catches it finding itself on PATH. The commands we start must not inherit them.
  const shimPath = process.env.CLAUDE_POD_SHIM_PATH;
  const ipc = /^[3-9]$|^[1-9][0-9]$/.test(process.env.CLAUDE_POD_CHANNEL_FD ?? '') ? Number(process.env.CLAUDE_POD_CHANNEL_FD) : null;
  delete process.env.CLAUDE_POD_IN_SHIM;
  delete process.env.CLAUDE_POD_SHIM_PATH;
  delete process.env.CLAUDE_POD_CHANNEL_FD;
  try {
    if (!SHIM_TOOLS.includes(tool)) throw new CliError(`claude-pod has no shim for ${tool}.`);
    let cwd;
    try {
      cwd = process.cwd();
    } catch (e) {
      throw new CliError(`the current folder can't be read (${e.code}).`);
    }
    const where = route(tool, args, cwd);
    if (where.to === 'host') {
      const env = { ...process.env, PATH: hostPath(shimPath) };
      if (ipc !== null) env.NODE_CHANNEL_FD = String(ipc);
      return outcome(await runChild(realBinary(tool), where.args, { env, ipcFd: ipc, argv0: tool }));
    }
    if (where.to === 'script') {
      // As npm would: in the project root, extra args quoted onto the command.
      const command = [where.script, ...where.extra.map(sq)].join(' ');
      const env = { ...process.env, PATH: hostPath(shimPath), npm_lifecycle_event: where.name };
      return outcome(await runChild('/bin/sh', ['-c', command], { cwd: where.root, env }));
    }
    // In this process rather than a second `claude-pod`: one launcher forwarding Ctrl-C to docker,
    // as with a plain `claude-pod exec`. No keychain secrets: every `pnpm install` would hand them
    // to postinstall scripts. An explicit `claude-pod exec` still gets them.
    return await launch({
      mode: 'exec', command: [tool, ...args], cwd: where.cwd, usesClaude: false, publishPorts: false, secrets: false, quiet: true,
    });
  } catch (e) {
    if (!(e instanceof CliError)) throw e;
    err(`claude-pod shim: ${clean(e.message)}`);
    if (e.hint) process.stderr.write(`  ${e.hint}\n`);
    return e.exitCode;
  }
}
