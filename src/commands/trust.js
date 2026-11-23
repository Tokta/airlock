import { parseArgs } from 'node:util';
import {
  approveReadOnly, assertSafeRoot, changedReadOnly, findProjectRoot, isTrusted, loadConfig, newReadOnly, shimsOffWarning, trust as recordTrust,
} from '../config.js';
import { canPrompt, confirm } from '../prompt.js';
import { CliError, bold, clean, ok, warn } from '../ui.js';

export const TRUST_HELP = `Usage: airlock trust

Shows this project's airlock.config.json and asks you to approve it. Pods can edit the
project, including this file, so a config is only used once you've approved its exact content;
unattended runs refuse a new or changed one. Needs a terminal (there is deliberately no --yes).

It also asks about "readOnly" paths that changed after you approved them while a pod that could
still write them (one started under an older config) was running: until you approve their
content, the host shims refuse them.`;

export async function trustCommand(argv) {
  const { values } = parseArgs({ args: argv, options: { help: { type: 'boolean', short: 'h' } } });
  if (values.help) {
    process.stdout.write(`${TRUST_HELP}\n`);
    return 0;
  }
  const found = findProjectRoot();
  if (!found.configPath) throw new CliError('No airlock.config.json in this project.', { hint: `Create one with ${bold('airlock init')}.` });
  assertSafeRoot(found.root);
  const config = loadConfig(found); // validates before we ask
  if (isTrusted(found.root, config.hash)) {
    ok(`${config.file} is already trusted.`);
  } else {
    if (!canPrompt()) throw new CliError('airlock trust needs a terminal.');
    warn(`Review ${config.file} (a pod can edit this file):`);
    process.stderr.write(`\n${clean(config.text.trimEnd(), '\n\t')}\n\n`);
    const off = shimsOffWarning(found.root, config);
    if (off) warn(off);
    const added = newReadOnly(found.root, config);
    if (added.length) warn(`New "readOnly" paths: ${added.map((r) => clean(r)).join(', ')}. Approving the config also approves their content as it is now, for your host to run; a pod may have written it. Review them (git diff) first.`);
    if (!(await confirm('Trust this config for this project?'))) throw new CliError('Not trusted.');
    recordTrust(found.root, config.hash, { shims: !!config.shims, readOnly: config.readOnly });
    ok('Trusted.');
  }
  const changed = changedReadOnly(found.root, config.readOnly);
  if (changed.length) {
    if (!canPrompt()) throw new CliError(`${changed.join(', ')} changed while a pod that could write them was running; airlock trust needs a terminal to approve them.`);
    warn(`These "readOnly" paths changed after you approved the config, while a pod started under an older config, which could still write them, was running: ${changed.map((r) => clean(r)).join(', ')}. Review them (git diff) before the host runs them.`);
    if (!(await confirm('Approve their current content?'))) throw new CliError('Not approved; the host shims keep refusing them.');
    approveReadOnly(found.root, changed);
    ok('Approved.');
  }
  return 0;
}
