// Preloaded (`node --import`) by the CLI tests: swaps the keychain's one `security` runner for
// fake-security.js, and lets FAKE_PLATFORM pretend to be another OS.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { useFakeKeychain } from '../../src/keychain.js';

const FAKE = fileURLToPath(new URL('./fake-security.js', import.meta.url));
useFakeKeychain({
  run: (args, input) => spawnSync(process.execPath, [FAKE, ...args], { encoding: 'utf8', input, env: process.env }),
  platform: process.env.FAKE_PLATFORM,
});
