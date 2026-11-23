import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { forgetShims, optedIntoShims, shimsIndexPath, writeShimsIndex } from '../config.js';
import { CONFIG_FILE, hostDir } from '../paths.js';
import { canPrompt, confirm } from '../prompt.js';
import { SHIM_TOOLS, shimsDir, sq } from '../shim.js';
import { ensurePrivateDir, kind, writeFileAtomic } from '../safefs.js';
import { CliError, bold, info, ok, warn } from '../ui.js';

export const SHIMS_HELP = `Usage: airlock shims [--forget]

Writes launchers for ${SHIM_TOOLS.join(', ')} into ~/.config/airlock/shims/ and prints
the line that puts them first on PATH. airlock never edits your shell rc files. Run it again
after moving airlock or the node it runs on.

In a project whose trusted airlock.config.json has "shims", each of those commands runs as
\`airlock exec --no-ports <cmd>\`, with none of the project's keychain secrets. Except:
  - the package scripts listed in "shims.host" (\`pnpm <script>\`, \`pnpm run <script>\`,
    \`npm run <script>\`, \`npm start\`/\`test\`, optionally followed by \`-- <args>\`): airlock
    runs them on the host itself, with /bin/sh in the project root, reading them from
    package.json, which must be under "readOnly";
  - \`node <file>\` where <file> is outside the project (a global CLI, airlock itself) or
    under "readOnly" or a path airlock always locks: it runs on the host.
With no config, or a config without "shims", the real command runs as before. An untrusted
config that has "shims" is refused rather than run on the host. So is a project whose approved
config had "shims" and no longer does, or is gone: a pod could have removed it.

  --forget   you deleted this project's config on purpose: run commands on the host again
             (asks first; to drop just the "shims" key, edit the config and run airlock trust)`;

const SHIM_JS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'airlock-shim.js');

// A POSIX sh launcher. It drops from PATH the shims folder, under any spelling (so the real
// binaries are found, and a shim never starts itself again), and any relative entry
// (`node_modules/.bin`, which a pod can fill). Then it starts airlock's shim with the absolute
// node `airlock shims` ran on, handing it the PATH it was started with, for whatever runs on the
// host. If airlock is gone, it says so and runs the real command, so uninstalling it doesn't
// break node.
//
// Fast path: for every tool but `node` (which is routed by its file), a command with no
// airlock.config.json above the current folder and no opted-in project there (the index
// `trust` keeps, compared with -ef so a different case or a symlink still matches) is not one the
// shims change: it runs the real command straight away, without starting node.
export function shimScript(tool, { dir = shimsDir(), shimJs = SHIM_JS, node = process.execPath, index = shimsIndexPath() } = {}) {
  const fast = tool === 'node' ? '' : `# Fast path: nothing above the current folder opted in, so run the real ${tool} straight away.
idx=${sq(index)}
if [ -f "$idx" ] && [ -r "$idx" ] && here=$(pwd -P 2>/dev/null) && [ -n "$here" ]; then
  d=$here
  while :; do
    [ -e "$d/airlock.config.json" ] && break
    hit=
    while IFS= read -r r; do
      if [ -n "$r" ] && [ "$d" -ef "$r" ]; then hit=1; break; fi
    done < "$idx"
    [ -n "$hit" ] && break
    [ "$d" = / ] && exec ${tool} "$@"
    d=\${d%/*}
    [ -n "$d" ] || d=/
  done
fi
`;
  return `#!/bin/sh
# Written by \`airlock shims\`. Runs ${tool} in a pod in projects that opted in.
shims=${sq(dir)}
if [ -n "$AIRLOCK_IN_SHIM" ]; then
  echo "airlock shim: ${tool} found the shims again on PATH; is $shims on it twice, spelled differently?" >&2
  exit 127
fi
AIRLOCK_SHIM_PATH=$PATH
set -f
p=
IFS=:
for d in $PATH; do
  case $d in
    /*) [ "$d" = "$shims" ] || [ "$d" = "$shims/" ] || [ "$d" -ef "$shims" ] || p="\${p:+$p:}$d" ;;
  esac
done
unset IFS
set +f
PATH=$p
export PATH
${fast}# A parent's IPC channel to \`node\` (spawn with 'ipc'): kept for the real node, not taken by the shim's.
if [ -n "$NODE_CHANNEL_FD" ]; then
  AIRLOCK_CHANNEL_FD=$NODE_CHANNEL_FD
  export AIRLOCK_CHANNEL_FD
  unset NODE_CHANNEL_FD
fi
js=${sq(shimJs)}
if [ ! -f "$js" ]; then
  echo "airlock shim: $js is gone, so ${tool} runs on the host. Remove $shims from PATH in your shell rc, or run airlock shims again." >&2
  exec ${tool} "$@"
fi
node=${sq(node)}
[ -x "$node" ] || node=node
AIRLOCK_IN_SHIM=1
export AIRLOCK_IN_SHIM AIRLOCK_SHIM_PATH
exec "$node" "$js" ${tool} "$@"
`;
}

// `--forget`: the nearest project upwards whose approved config had "shims", once its config is
// gone. A person confirms it in a terminal: a pod that deleted the config must not be able to
// talk an agent into turning the shims off.
async function forget() {
  let d = fs.realpathSync.native(process.cwd());
  while (!optedIntoShims(d) && path.dirname(d) !== d) d = path.dirname(d);
  if (!optedIntoShims(d)) throw new CliError('No project here has shims turned on.');
  const config = path.join(d, CONFIG_FILE);
  if (kind(config) !== 'missing') {
    throw new CliError(`${config} is still there, so there's nothing to forget.`, {
      hint: `To turn the shims off, remove "shims" from it and approve it with ${bold('airlock trust')}.`,
    });
  }
  if (!canPrompt()) throw new CliError('airlock shims --forget needs a terminal.');
  warn(`${config} is gone. It had "shims", and a pod could have deleted it.`);
  if (!(await confirm(`Run pnpm, npm, node & co. on the host again in ${d}?`))) throw new CliError('Not changed.');
  forgetShims(d);
  ok(`Shims off for ${d}: its commands run on the host again.`);
  return 0;
}

export async function shims(argv) {
  const { values } = parseArgs({ args: argv, options: { forget: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) {
    process.stdout.write(`${SHIMS_HELP}\n`);
    return 0;
  }
  if (values.forget) return forget();
  const dir = writeShims();
  ok(`Wrote ${SHIM_TOOLS.length} shims to ${bold(dir)} (they run airlock on ${process.execPath})`);
  info('Put them first on PATH (in ~/.zshrc or ~/.bashrc, then open a new terminal):');
  process.stdout.write(`${pathLine(dir)}\n`);
  return 0;
}

// Writes the launchers into `dir` (the shims folder unless `airlock migrate` bridges an old one)
// and returns it.
export function writeShims(dir = shimsDir()) {
  ensurePrivateDir(hostDir());
  ensurePrivateDir(dir);
  writeShimsIndex(); // approvals made before the shims existed
  for (const tool of SHIM_TOOLS) writeFileAtomic(path.join(dir, tool), shimScript(tool, { dir }), 0o700);
  return dir;
}

export function pathLine(dir = shimsDir()) {
  const home = os.homedir();
  const shown = dir.startsWith(`${home}/`) ? `$HOME/${path.relative(home, dir)}` : dir;
  return `export PATH="${shown}:$PATH"`;
}
