import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { assertSafeRoot, findProjectRoot, loadConfig, optedIntoShims, trust } from '../config.js';
import { docker } from '../docker.js';
import { CONFIG_FILE } from '../paths.js';
import { CliError, bold, detail, info, ok } from '../ui.js';

export const INIT_HELP = `Usage: airlock init

Creates ${CONFIG_FILE} at the project root (the git root, or the current folder) and marks it
trusted. Keys:
  network    Docker bridge network to join, e.g. "<compose-project>_default", so the pod reaches
             services by name (postgres:5432). "none" cuts networking. "host" is not allowed.
  ports      container ports to publish on free 127.0.0.1 ports, e.g. [3000, 3131];
             {"port": 3000, "fixed": true}: exec and shell pods publish 127.0.0.1:3000 itself and
             refuse to start if it is in use; agent pods get a free port for it
  envFile    .env-style file inside the project whose values can be used as \${VAR} in "env"
  env        extra environment for the pod, e.g. {"DATABASE_URL": "postgresql://u:\${PW}@postgres/db"}
             (\${VAR} comes from envFile only, never from your host environment)
  resources  {"pids": 4096, "memory": "4g", "cpus": 2}
  readOnly   project files the host runs, which pods can't change, e.g. ["package.json", "scripts"]
  secrets    keychain secrets for shell and exec pods (airlock secret set NAME), e.g. ["API_KEY"]
  shims      {"host": ["dev"]}: host pnpm/npm/node go to a pod, except these scripts (airlock shims)

After editing the file, approve the new content with \`airlock trust\`.`;

// Docker Compose names a project's default network "<folder>_default" (lowercased, and stripped
// of characters it doesn't allow). Suggest it when it exists.
function detectComposeNetwork(root) {
  const guess = `${path.basename(root).toLowerCase().replace(/[^a-z0-9_-]/g, '')}_default`;
  try {
    return docker(['network', 'inspect', guess], { stdio: 'ignore' }).status === 0 ? guess : null;
  } catch {
    return null;
  }
}

export async function init(argv) {
  const { values } = parseArgs({ args: argv, options: { help: { type: 'boolean', short: 'h' } } });
  if (values.help) {
    process.stdout.write(`${INIT_HELP}\n`);
    return 0;
  }
  const found = findProjectRoot();
  if (found.configPath) throw new CliError(`${found.configPath} already exists.`);
  const { root } = found;
  assertSafeRoot(root, { requireProject: false });
  // A fresh config (and its trust record) would quietly end the project's shims opt-in.
  if (optedIntoShims(root)) {
    throw new CliError(`${root} had a ${CONFIG_FILE} with "shims", and it is gone. A pod may have deleted it.`, {
      hint: 'Restore it (from git, say). If you removed it on purpose, see airlock shims --help.',
    });
  }

  const config = { $comment: 'airlock project config — run `airlock init --help` for the keys.' };
  const network = detectComposeNetwork(root);
  if (network) config.network = network;
  config.ports = [];
  if (fs.existsSync(path.join(root, '.env'))) config.envFile = '.env';
  config.env = {};

  const file = path.join(root, CONFIG_FILE);
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx' });
  trust(root, loadConfig({ root, configPath: file }).hash);
  ok(`Created ${bold(file)} (trusted)`);
  if (network) detail(`detected Docker network: ${network}`);

  info('Next steps');
  process.stderr.write(`  1. Fill in ports/env in ${CONFIG_FILE}, then ${bold('airlock trust')} to approve the edit.\n`);
  process.stderr.write(`  2. Let agents launch pods without prompts — add to .claude/settings.json:\n`);
  process.stderr.write(`       "permissions": { "allow": ["Bash(airlock run:*)", "Bash(airlock guide:*)"] }\n`);
  process.stderr.write(`     and tell agents to start with ${bold('airlock guide')}.\n`);
  process.stderr.write(`  3. Headless runs: ${bold('airlock run --prompt-file /tmp/task.md --out /tmp/task')}\n`);
  return 0;
}
