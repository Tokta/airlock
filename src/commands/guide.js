import path from 'node:path';
import { parseArgs } from 'node:util';
import { assertSafeRoot, findProjectRoot, isTrusted, loadConfig } from '../config.js';
import { allowedRunDirs, readToken } from '../host.js';
import { recordedImageId } from '../docker.js';
import { hostSettingsPath } from '../paths.js';
import { clean } from '../ui.js';

export const GUIDE_HELP = `Usage: airlock guide [--no-status]

Prints a briefing for AI agents: how to delegate a task to a sandboxed Claude with
\`airlock run\`, how to read the results, what each failure means and what to do about it,
and what the pod can and can't do. Ends with a live status of the current project.
Read-only: it never changes anything, so it is safe to auto-approve.`;

const GUIDE = `# airlock — guide for agents

airlock runs Claude Code inside a Docker container ("pod") that can only see the current
project. Use it to hand a task to a sub-agent that runs with --dangerously-skip-permissions,
without giving that sub-agent the rest of this machine.

## Delegate a task

1. Write the full task prompt to a file in your scratchpad (a temp dir), e.g.
   /tmp/…/scratchpad/step-3.md. Never put prompts or outputs inside the project.
2. Run exactly this form — one command, absolute paths, no cd, no variables, no $(…),
   no redirects, no pipes:

       airlock run --model opus --prompt-file /abs/scratchpad/step-3.md --out /abs/scratchpad/step-3

   Run it from inside the project (any subfolder works; the project root is found upwards).
3. If airlock rejects the command itself (bad option, disallowed path, not in a project) it
   fails at once with exit 1 or 2, the reason on stderr, and writes NO files — so check the
   command's own exit status first. Otherwise it prints \`exit=<code>\` when done, exits with
   that code, and you read:
       /abs/scratchpad/step-3.out    the sub-agent's answer (stdout)
       /abs/scratchpad/step-3.err    its stderr, and launcher errors
       /abs/scratchpad/step-3.exit   the exit code (written last; its presence = finished)
4. The sub-agent's file edits and commits are already in the project (it's bind-mounted).
   Review them (git diff / git log) before relying on them.

Options: --model opus|sonnet|haiku|<id>, --output-format text|json|stream-json,
--prompt "short text" instead of --prompt-file, --ports to publish the project's dev-server
ports, and anything after \`--\` is passed to claude (e.g. -- --max-turns 30).
Long tasks: run the command in the background if your tool times out; the pod keeps running
until the launcher exits, and is stopped automatically if the launcher is killed.
Several runs may go in parallel, but runs in the same project share its files and git repo.

## When it fails

Launcher warnings (missing token, quarantined files) are on the command's stderr, not in .err;
the sub-agent's own errors (e.g. "Not logged in", 401) are in .err.

| You see (in .err or on stderr) | Meaning | Do this |
|---|---|---|
| "…config.json is new or has changed since you approved it" | the project config needs human approval | STOP. Tell the user to review it and run \`airlock trust\`. Never approve it yourself. |
| "No login token" / "Not logged in" / 401 | no or invalid login, or \`claude\` was started inside an \`exec\`/\`shell\` pod (they get no token, only the project's secrets, which may include an API key) | Use \`airlock run\` for sub-agents. Otherwise tell the user to run \`claude setup-token\` then \`airlock auth\`. |
| "Image 'airlock' not found" / "not the one airlock built" | image missing or replaced | Tell the user to run \`airlock build\`. |
| "Docker daemon is not running" / "network … not found" | Docker or the app stack is down | Tell the user (e.g. start Docker, \`docker compose up -d\`). |
| "--prompt-file/--out … outside the allowed folders" / "inside the project" | path rule | Move the file to your scratchpad (temp dir). |
| "Refusing to mount …" | not run from inside a project | Run from the project folder. |
| "…is a symlink…" / "…commondir exists…" / "quarantined" | a previous pod may have tampered with protected files | STOP and tell the user; don't delete or restore anything yourself. |
| "Unknown option" / "Unexpected argument" / "Pass exactly one of" | bad airlock arguments | Fix the command (see \`airlock run --help\`). |
| any other non-zero exit | the sub-agent itself failed | Read .out and .err; retry once at most with a clearer prompt. |

## Inside the pod (what the sub-agent can and can't do)

- Can: read and write the project, run its tools (node, pnpm, git, gh, jq, curl), reach the
  internet, reach the app's services if the project config joins a Docker network.
- Cannot: see anything outside the project (home dir, SSH keys, other repos), push to git
  or use GitHub credentials (none are present), change .git/hooks, the core.hooksPath
  folder, .git/config, .claude/, .mcp.json, .envrc, .vscode/, .idea/ (read-only). Files like
  these that it creates are quarantined after the run. \`git config\` on the repo fails
  (\`--global\` only affects the pod); \`git commit\` works with the user's global identity;
  use \`git -c key=value …\`.
- The login token is in \`run\` and \`claude\` pods only (code there can read it);
  \`airlock exec\` and \`shell\` pods have none, so \`claude\` inside them is not logged in
  (unless the project's secrets include ANTHROPIC_API_KEY, which bills the API).
  The project's keychain secrets (API keys) go to \`exec\` and \`shell\` pods only, never to
  sub-agents: a missing API key inside a \`run\` pod is by design, not a bug to work around.
- Detect the pod from inside with \`[ "$AIRLOCK" = 1 ]\`.

## Never

- Never run \`airlock trust\`, \`airlock auth\`, \`airlock secret\`, \`airlock uninstall\`, or edit
  airlock.config.json to get a run working — those are the user's decisions.
- Never pass secrets in --prompt; the sub-agent sees everything you send it.
- Never use \`airlock exec claude\` (or \`claude\` in a \`shell\` pod) for a sub-agent: those
  pods hold the project's API keys. Use \`airlock run\`.
- Never push the sub-agent's work without reviewing the diff first.

Other commands (for humans): \`airlock doctor\` (full check), \`airlock ps\` / \`stop\`,
\`airlock --help\`.
`;

// Live status for the current folder, from host-side state only (no Docker calls, no writes).
function status() {
  const lines = ['## Status here', ''];
  // Rows can include text from files a pod wrote (config errors, paths): escape it so it can't
  // add lines that look like more status rows or instructions.
  const row = (okay, text) => lines.push(`- ${okay ? 'ok  ' : 'FAIL'} ${clean(text)}`);
  let found;
  try {
    found = findProjectRoot();
    assertSafeRoot(found.root);
    row(true, `project: ${found.root}`);
  } catch (e) {
    row(false, `project: ${e.message}`);
  }
  if (found) {
    if (!found.configPath) row(true, 'config: none (defaults)');
    else {
      try {
        const config = loadConfig(found);
        const trusted = isTrusted(found.root, config.hash);
        row(trusted, trusted
          ? `config: ${path.basename(found.configPath)} approved`
          : 'config: new or changed — runs will refuse until the user runs `airlock trust`');
      } catch (e) {
        row(false, `config: ${e.message}`);
      }
    }
  }
  const token = !!readToken();
  row(token, token ? 'login token: stored' : 'login token: missing — user must run `claude setup-token` + `airlock auth`');
  const image = !!recordedImageId();
  row(image, image ? 'image: built by airlock' : 'image: not built yet — user must run `airlock build`');
  try {
    row(true, `allowed --prompt-file/--out folders: ${allowedRunDirs().join(', ')} (more via "runDirs" in ${hostSettingsPath()})`);
  } catch (e) {
    row(false, e.message);
  }
  return `${lines.join('\n')}\n`;
}

export async function guide(argv) {
  const { values } = parseArgs({ args: argv, options: { 'no-status': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) {
    process.stdout.write(`${GUIDE_HELP}\n`);
    return 0;
  }
  process.stdout.write(GUIDE);
  if (!values['no-status']) process.stdout.write(`\n${status()}`);
  return 0;
}
