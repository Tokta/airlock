import fs from 'node:fs';
import path from 'node:path';
import { auth } from './commands/auth.js';
import { build } from './commands/build.js';
import { doctor } from './commands/doctor.js';
import { guide } from './commands/guide.js';
import { init } from './commands/init.js';
import { ps, stop } from './commands/pods.js';
import { run } from './commands/run.js';
import { secret } from './commands/secret.js';
import { shims } from './commands/shims.js';
import { trustCommand } from './commands/trust.js';
import { uninstall } from './commands/uninstall.js';
import { launch } from './launch.js';
import { PKG_DIR } from './paths.js';
import { CliError, err } from './ui.js';

const HELP = `claude-pod — run Claude Code in a Docker sandbox scoped to one project folder.

Usage: claude-pod [command] [args]

AI agents: start with \`claude-pod guide\` — how to delegate a task, read results, handle errors.

Pod commands (mount the current project and start a container):
  (none) | shell          bash shell in the pod (--no-ports: publish none)
  claude [args...]        Claude in the pod; args are passed through unchanged
  exec <cmd> [args...]    any command in the pod, e.g. exec pnpm test
  exec --no-ports <cmd>   the same, publishing no ports (tests beside a running dev server)
  run --prompt-file F …   headless Claude task with --dangerously-skip-permissions
                          (see: claude-pod run --help)

Setup & management:
  build                   build the image (once, and to update Claude Code)
  auth                    store the login token from \`claude setup-token\`
  init                    create claude-pod.config.json for this project
  trust                   review and approve this project's (changed) config
  secret set|list|rm      this project's keychain secrets for shell/exec pods (macOS)
  shims                   write host launchers so pnpm/npm/node/… go to a pod in opted-in projects
  ps [--all]              list running pods
  stop [NAME...] [--all]  stop pods
  guide                   briefing for AI agents + status of this project (read-only)
  doctor                  check Docker, image, login and project config
  uninstall [--yes]       remove the image and pod state
  --version | --help

The project root is the nearest folder (upwards) with claude-pod.config.json, else the git root.
Pods get CLAUDE_POD=1 and, per published port, CLAUDE_POD_PORT_<n>.

Env overrides: NET=none (no network); PIDS, MEMORY, CPUS (resource caps).`;

const version = () => JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8')).version;

// Commands that open a pod. `shell`/`claude`/`exec` publish the config's ports (you're likely
// hitting a dev server); `run` doesn't by default (see run.js). Fixed ports are published as
// themselves only by the dev-server paths, `shell` and `exec`; agent pods get random ones (see
// allocatePorts).
const EXEC_USAGE = 'Usage: claude-pod exec [--no-ports] [--] <command> [args...]';

// `exec [--no-ports] [--] <cmd> [args...]`. Only flags before the command are ours; everything
// from the command on is passed through untouched (`exec pnpm test --no-ports` is pnpm's flag).
function execCommand(args) {
  let rest = args;
  if (['--help', '-h'].includes(rest[0]) || (rest[0] === '--no-ports' && ['--help', '-h'].includes(rest[1]))) {
    process.stdout.write(`${EXEC_USAGE}\n\nRuns a command in a fresh pod. --no-ports publishes no ports, so tests can run beside a dev server.\n`);
    return 0;
  }
  const publishPorts = rest[0] !== '--no-ports';
  if (!publishPorts) rest = rest.slice(1);
  const dashes = rest[0] === '--';
  if (dashes) rest = rest.slice(1);
  if (!rest.length) throw new CliError(EXEC_USAGE);
  if (!dashes && rest[0].startsWith('-')) {
    throw new CliError(`Unknown exec option "${rest[0]}".`, { hint: EXEC_USAGE });
  }
  return launch({ mode: 'exec', command: rest, usesClaude: false, publishPorts, ownFixedPorts: true });
}

// `shell [--no-ports]`: a shell beside a running dev server needs no ports of its own.
function shellCommand(args) {
  if (args.length > 1 || (args.length && args[0] !== '--no-ports')) {
    throw new CliError('shell takes no arguments except --no-ports; use claude-pod exec <cmd>.');
  }
  return launch({ mode: 'shell', command: ['bash'], usesClaude: false, publishPorts: !args.length, ownFixedPorts: true });
}

const COMMANDS = {
  shell: shellCommand,
  claude: (args) => launch({ mode: 'claude', command: ['claude', ...args], usesClaude: true, publishPorts: true }),
  exec: execCommand,
  run,
  secret,
  shims,
  build,
  auth,
  init,
  trust: trustCommand,
  ps,
  stop,
  doctor,
  guide,
  uninstall,
};

export async function main(argv) {
  const [cmd = 'shell', ...rest] = argv;
  try {
    if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
      process.stdout.write(`${HELP}\n`);
      return 0;
    }
    if (cmd === '--version' || cmd === '-v') {
      process.stdout.write(`${version()}\n`);
      return 0;
    }
    const handler = Object.hasOwn(COMMANDS, cmd) ? COMMANDS[cmd] : null;
    if (!handler) throw new CliError(`Unknown command "${cmd}".`, { hint: 'Run claude-pod --help. To run a program in the pod: claude-pod exec <cmd>.' });
    return await handler(rest);
  } catch (e) {
    if (e instanceof CliError) {
      err(e.message);
      if (e.hint) process.stderr.write(`  ${e.hint}\n`);
      return e.exitCode;
    }
    if (e?.code && String(e.code).startsWith('ERR_PARSE_ARGS')) {
      err(e.message);
      return 2;
    }
    throw e;
  }
}
