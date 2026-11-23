import { parseArgs } from 'node:util';
import { assertSafeRoot, findProjectRoot, loadConfig } from '../config.js';
import {
  assertSupported, hasSecret, listAllSecrets, listSecrets, removeSecret, secretNameError, secretValueError, setSecret,
} from '../keychain.js';
import { canPrompt, readSecret } from '../prompt.js';
import { CliError, bold, ok, warn } from '../ui.js';

export const SECRET_HELP = `Usage: claude-pod secret set NAME | list [--all] | rm NAME

Keeps this project's API keys in the macOS login keychain instead of a plaintext .env.
Names listed under "secrets" in claude-pod.config.json are fetched at launch and handed to
\`shell\` and \`exec\` pods (never \`claude\` or \`run\` pods) through a private env-file.

  set NAME   store a value: typed with hidden input, or piped (\`claude-pod secret set X < file\`)
  list       this project's stored names (never values), and whether the config uses them;
             --all: every project's, as <project key>/<NAME>
  rm NAME    delete one

Each is a generic password with service "claude-pod" and an account named after this project's
path, so one project can never read another's; after moving or renaming a project, set them again.
Values are printable ASCII. Any process on the host running as you can read them without a
prompt, as with a .env file. macOS only for now.`;

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function checkName(name) {
  if (name === undefined) throw new CliError('Name the secret, e.g. claude-pod secret set RESEND_API_KEY.');
  const error = secretNameError(name);
  if (error) throw new CliError(`Secret name ${JSON.stringify(name)} ${error}.`);
  return name;
}

// The config's secret names, if there is a config we can read. Trust doesn't matter here: this
// only decides which hints to print.
function configured(found) {
  try {
    return loadConfig(found).secrets;
  } catch {
    return [];
  }
}

export async function secret(argv) {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true, options: { all: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
  });
  const [sub, name, ...extra] = positionals;
  if (values.help || !sub) {
    process.stdout.write(`${SECRET_HELP}\n`);
    return values.help ? 0 : 2;
  }
  if (extra.length) throw new CliError(`Unexpected argument "${extra[0]}".`);
  if (values.all && sub !== 'list') throw new CliError('--all only goes with list.');
  assertSupported();
  if (sub === 'list' && values.all) {
    if (name !== undefined) throw new CliError(`Unexpected argument "${name}".`);
    for (const a of listAllSecrets()) process.stdout.write(`${a}\n`);
    return 0;
  }
  const found = findProjectRoot();
  assertSafeRoot(found.root);
  const { root } = found;

  if (sub === 'set') {
    checkName(name);
    let value;
    if (!process.stdin.isTTY) value = (await readAll(process.stdin)).replace(/\r?\n$/, '');
    else if (canPrompt()) value = await readSecret(`${name}: `);
    else throw new CliError('No value given.', { hint: `Pipe it in: claude-pod secret set ${name} < file` });
    const error = secretValueError(value);
    if (error) throw new CliError(`The value for ${name} ${error}.`);
    const had = hasSecret(root, name);
    setSecret(root, name, value);
    ok(`${had ? 'Replaced' : 'Stored'} ${bold(name)} in the keychain for ${root}`);
    if (!configured(found).includes(name)) warn(`${name} is not under "secrets" in the config yet, so no pod gets it until you add it.`);
    return 0;
  }
  if (sub === 'rm') {
    checkName(name);
    if (!removeSecret(root, name)) throw new CliError(`No secret ${name} stored for ${root}.`);
    ok(`Removed ${bold(name)}`);
    return 0;
  }
  if (sub === 'list') {
    if (name !== undefined) throw new CliError(`Unexpected argument "${name}".`);
    const stored = listSecrets(root);
    const wanted = configured(found);
    if (!stored.length && !wanted.length) process.stderr.write(`No secrets stored for ${root}.\n`);
    for (const n of stored) process.stdout.write(`${n}${wanted.includes(n) ? '' : '  (not in the config)'}\n`);
    for (const n of wanted.filter((w) => !stored.includes(w))) process.stdout.write(`${n}  (in the config, not stored)\n`);
    return 0;
  }
  throw new CliError(`Unknown secret command "${sub}".`, { hint: 'Use set NAME, list or rm NAME.' });
}
