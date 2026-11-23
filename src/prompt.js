// Terminal prompts. Only used when a human is present: stdin and stderr are both terminals.
import readline from 'node:readline/promises';
import { CliError } from './ui.js';

export const canPrompt = () => !!process.stdin.isTTY && !!process.stderr.isTTY;

export async function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

// Reads a line without echoing it (for tokens and secrets). Any other control character (a tab,
// an arrow key's escape sequence) is refused rather than dropped, so a value is never silently
// changed on its way in.
export function readSecret(question) {
  return new Promise((resolve, reject) => {
    const { stdin, stderr } = process;
    stderr.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const done = (err) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      stderr.write('\n');
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u0003') return done(new CliError('Cancelled.'));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch < ' ') return done(new CliError('That input has a control character (a tab or arrow key?). Paste the value plainly, or pipe it in.'));
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}
