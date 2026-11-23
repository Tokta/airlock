#!/usr/bin/env node
// Stand-in for macOS `/usr/bin/security` in tests, run through fake-keychain.js. Keeps generic
// passwords in the JSON file FAKE_KEYCHAIN ({"service/account": "value"}) and appends each argv to FAKE_SECURITY_LOG, so tests can check no value is ever on a command line.
import fs from 'node:fs';

const file = process.env.FAKE_KEYCHAIN;
const load = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {});
const save = (db) => fs.writeFileSync(file, JSON.stringify(db));
const args = process.argv.slice(2);
if (process.env.FAKE_SECURITY_LOG) fs.appendFileSync(process.env.FAKE_SECURITY_LOG, `${JSON.stringify(args)}\n`);
const opt = (list, flag) => list[list.indexOf(flag) + 1];

function run(argv) {
  const db = load();
  const key = `${opt(argv, '-s')}/${opt(argv, '-a')}`;
  // FAKE_SECURITY_FAIL: a keychain that can't be used (locked, over SSH).
  if (process.env.FAKE_SECURITY_FAIL) {
    process.stderr.write('security: SecKeychainSearchCopyNext: User interaction is not allowed.\n');
    return 36;
  }
  switch (argv[0]) {
    case 'find-generic-password':
      if (!Object.hasOwn(db, key)) {
        process.stderr.write('security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n');
        return 44;
      }
      if (!argv.includes('-w')) return 0;
      // Like the real one: a value that isn't printable ASCII comes out as hex.
      process.stdout.write(/^[\x20-\x7e]*$/.test(db[key]) ? `${db[key]}\n` : `${Buffer.from(db[key]).toString('hex')}\n`);
      return 0;
    case 'add-generic-password': {
      if (!argv.includes('-U') && Object.hasOwn(db, key)) return 45;
      db[key] = Buffer.from(opt(argv, '-X'), 'hex').toString('utf8');
      save(db);
      return 0;
    }
    case 'delete-generic-password':
      if (!Object.hasOwn(db, key)) return 44;
      delete db[key];
      save(db);
      return 0;
    case 'dump-keychain':
      for (const k of Object.keys(db)) {
        const [svce, ...acct] = k.split('/');
        process.stdout.write(`keychain: "/fake/login.keychain-db"\nversion: 512\nclass: "genp"\nattributes:\n    "acct"<blob>="${acct.join('/')}"\n    "svce"<blob>="${svce}"\n`);
      }
      if (process.env.FAKE_DUMP_EXTRA) process.stdout.write(fs.readFileSync(process.env.FAKE_DUMP_EXTRA, 'utf8'));
      return 0;
    default:
      return 1;
  }
}

if (args[0] === '-i') {
  // Like the real one: exits with the last command's status.
  let code = 0;
  for (const line of fs.readFileSync(0, 'utf8').split('\n').filter(Boolean)) code = run(line.trim().split(/\s+/));
  process.exit(code);
}
process.exit(run(args));
