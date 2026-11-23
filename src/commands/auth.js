import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { readToken, saveToken, validateToken } from '../host.js';
import { stateRoot, tokenPath } from '../paths.js';
import { canPrompt, readSecret } from '../prompt.js';
import { kind } from '../safefs.js';
import { CliError, bold, detail, ok, warn } from '../ui.js';

export const AUTH_HELP = `Usage: airlock auth [--from-env] [--remove]

Stores the login the pods use: a long-lived token for your Claude subscription (Pro/Max usage,
not API billing). Create one on the host (opens the browser) with:

  claude setup-token

then run \`airlock auth\` and paste it (or pipe it in: \`airlock auth < file\`).
The token file is kept in ~/.config/airlock/oauth-token (0600), a folder no pod can see. The
token value is handed as CLAUDE_CODE_OAUTH_TOKEN to the pods that run Claude (\`airlock
claude\` and \`airlock run\`), so code inside those pods CAN read it. \`shell\` and \`exec\`
pods get no token.
It never rotates, so parallel pods can't log each other out.

Options:
  --from-env   read the token from $CLAUDE_CODE_OAUTH_TOKEN
  --remove     delete the stored token`;

async function readAll(stream) {
  let s = '';
  for await (const chunk of stream) s += chunk;
  return s;
}

export async function auth(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'from-env': { type: 'boolean' },
      remove: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    process.stdout.write(`${AUTH_HELP}\n`);
    return 0;
  }
  if (values.remove) {
    fs.rmSync(tokenPath(), { force: true });
    ok('Login token removed.');
    return 0;
  }

  let raw;
  if (values['from-env']) {
    raw = process.env.CLAUDE_CODE_OAUTH_TOKEN || '';
    if (!raw) throw new CliError('$CLAUDE_CODE_OAUTH_TOKEN is not set.');
  } else if (!process.stdin.isTTY) {
    raw = await readAll(process.stdin);
  } else if (canPrompt()) {
    process.stderr.write(`Create a token on the host with ${bold('claude setup-token')}, then paste it here.\n`);
    raw = await readSecret('Token: ');
  } else {
    throw new CliError('No token given.', { hint: 'Pipe it in, or pass --from-env.' });
  }
  const token = validateToken(raw);
  if (!token.startsWith('sk-ant-oat')) warn('This does not look like a `claude setup-token` token (sk-ant-oat…); storing it anyway.');
  const had = readToken();
  saveToken(token);
  ok(`${had ? 'Replaced' : 'Stored'} the login token in ${bold(tokenPath())}`);

  // The pre-token design copied the host's OAuth login (with its refresh token) into a folder
  // every pod could read. It's unused now; don't leave it lying around.
  const legacy = path.join(stateRoot(), '.credentials.json');
  if (kind(legacy) !== 'missing') {
    fs.rmSync(legacy, { force: true });
    detail(`removed the old copied login ${legacy} (no longer used)`);
  }
  return 0;
}
