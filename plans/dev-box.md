# Dev box — run a project's whole dev loop in a pod

**Status:** Not started
**Created:** 2026-11-15

## Why

claude-pod treats the pod as hostile because the agent inside may be prompt-injected. A
malicious npm package is the same threat: code that runs with the project's permissions and
should see nothing else. Today the pod contains agents, but the dev loop still runs on the host:
`pnpm install`, `pnpm dev`, tests and builds. A bad package installed that way can read
`~/.ssh`, cloud keys, browser data and every other project.

The goal: in a project that opts in, every package command runs in a pod, whether a person
typed it or the host Claude session did, with the same protections the agent pods already have.
`claude-pod exec pnpm dev` already works. What is missing is below, in order.

The guard is there to stop accidents and narrow what a package can reach. Someone who calls
`/usr/local/bin/node` by its full path on the host gets past it; that is accepted.

## Batch 1 — two security gaps (do first; both stand on their own)

### The login token reaches only pods that run Claude

`launch()` adds `CLAUDE_CODE_OAUTH_TOKEN` to every pod's env file
([src/launch.js](../src/launch.js), `podEnv`). A package running under `exec pnpm dev` can read
it and, with the network open, send it out.

- Pass the token only when `usesClaude` is true, which means `claude` and `run`. `shell` and
  `exec` get no token.
- `shell` users who start `claude` by hand get the existing "not logged in" path. Its message
  points at `claude-pod claude`.
- README "Login", `AUTH_HELP` in [src/commands/auth.js](../src/commands/auth.js) and
  `claude-pod guide`: say which commands carry the token.
- Test: `buildRunArgs` is pure, but the token is written by `launch()`. Assert on the env-file
  content for an `exec` launch against the fake docker in [test/helpers.js](../test/helpers.js).

### Lock the directory `core.hooksPath` points at

`.git/config` is read-only, so a pod cannot change `core.hooksPath`. But when a project sets it
to a folder inside the repo (ops-olive uses `.githooks`), that folder is ordinary project files.
The pod can rewrite `.githooks/pre-commit`, and the host runs it on the next commit.

- In `protectedMounts()` ([src/protect.js](../src/protect.js)), read `core.hooksPath` with
  `git config --file <root>/.git/config --get core.hooksPath`. Never run plain `git config` in
  the project, which would honour an includeIf the pod planted elsewhere.
- If it resolves inside the project, lock it like `.git/hooks`: a read-only dir, created if
  missing. If it is a symlink or resolves outside the project, refuse to start, as the other
  locked paths already do.
- README "Project files that would run on your host": add the row.

## Batch 2 — `readOnly` paths in the config

Project scripts the host runs (`scripts/deploy.sh`, `package.json` scripts, `Makefile`) are
pod-writable today. The README lists that under "What is still exposed". Let the project name
more paths to lock:

```json
{ "readOnly": ["scripts", "package.json", "pnpm-workspace.yaml", "docker-compose.yml", "infra"] }
```

- `validate()` in [src/config.js](../src/config.js): an array of relative paths with no `..`,
  no absolute paths, and nothing under `node_modules`. The config is trust-gated, so a pod
  cannot add to or remove from the list without you approving it.
- `protectedMounts()` takes the list:
  - a path that exists is mounted read-only, with the same symlink and outside-the-project
    refusal as `LOCKED`;
  - a path that is missing joins `WATCHED`, so one a pod creates is quarantined.
- Test in [test/protect.test.js](../test/protect.test.js): an existing file and dir are mounted
  `:ro`; a symlink is refused; a missing one a pod creates is quarantined.

## Batch 3 — fixed ports, and `exec --no-ports`

Agents want random free ports so parallel pods never clash. A dev server usually needs its real
port, because OAuth callbacks, auth base URLs and cookies are set to it.

- A `ports` entry may be a number (random host port, as today) or `{ "port": 3000, "fixed": true }`.
  A fixed entry publishes on `127.0.0.1:3000`. If that port is busy, the pod refuses to start
  with a clear message: "port 3000 is in use — is the dev server already running?". It never
  falls back to a random port.
- `exec --no-ports`: no ports published at all. The shims (batch 6) always use it, so
  `pnpm test` beside a running `pnpm dev` never fights over 3000.
- `CLAUDE_POD_PORT_<n>` stays as it is (equal to `n` for a fixed port).
- Tests: [test/config.test.js](../test/config.test.js) for the new shape;
  [src/ports.js](../src/ports.js) maps fixed ports without probing, and a busy fixed port
  throws.

## Batch 4 — package-manager caches that outlive a pod

`HOME` in the pod is ephemeral, so every pod starts with an empty pnpm store and corepack
cache. When a project pins a different pnpm in `packageManager` than the image's 12.6.0, corepack
downloads it on every launch, and every `pnpm install` downloads everything again.

- Per project, `~/.claude-pod/pods/<project>/cache/` (inside the state dir already mounted at
  `~/.claude`). Set `COREPACK_HOME`, `npm_config_store_dir` (pnpm) and `npm_config_cache` (npm)
  to folders under it.
- It is pod-writable, so a pod can poison it, but only for later pods of the same project, which
  already share the working tree. Nothing on the host reads it.
- README "Side effects": mention it, and that `claude-pod uninstall` removes it.

## Batch 5 — secrets from the host keychain

A dev server needs API keys. Today they sit in a plaintext `.env` in the project, which every pod
and every host process can read. Let the launcher fetch them at start-up instead:

```json
{ "secrets": ["ANTHROPIC_API_KEY", "RESEND_API_KEY"] }
```

- `claude-pod secret set NAME`: hidden input, reusing `readSecret` from
  [src/prompt.js](../src/prompt.js), or piped on stdin. It stores a generic password with
  service `claude-pod` and account `<project key>/<NAME>`. The project key is the same one
  `projectStateDir()` uses, so one project can never read another's secrets, whatever its config
  says. Also `secret list` (names only, never values) and `secret rm NAME`.
- `security add-generic-password -U -s claude-pod -a <account> -w` reads the value from its own
  prompt, never from argv. Check whether that prompt can be fed from our hidden input without
  the value appearing in `ps`. If it cannot, write the value through `security -i` on stdin.
- Launch: for each name in `secrets`, `security find-generic-password -s claude-pod -a <account> -w`.
  The value goes into the private env file, like the token, never argv. A name with no entry is
  skipped with a warning, so the app falls back to whatever it does without the key.
- **Secrets reach `shell` and `exec` pods only, never `claude` or `run`.** A prompt-injected
  agent with an open network is exactly what should not hold the app's keys. This also keeps the
  existing rule that `ANTHROPIC_*` never reaches Claude, where it would switch Claude from the
  subscription to API billing. So `RESERVED_ENV` still applies to `env`, but a secret named
  `ANTHROPIC_API_KEY` is allowed because it never meets Claude.
- macOS only in this batch. Elsewhere `secret` errors with "keychain secrets are macOS-only for
  now". Linux `secret-tool` is a later batch if anyone needs it.
- `doctor`: list each configured secret as stored or missing.
- Tests: the keychain calls go through one function, so tests swap in a fake, the same way the
  fake docker works.

## Batch 6 — host shims: package commands go to the pod

So that nobody has to remember `claude-pod exec`, in a person's terminal or in the host Claude
session (which uses the same `PATH`):

- `claude-pod shims` writes small launchers for `pnpm`, `npm`, `npx`, `node`, `tsx`, `yarn`,
  `bunx` and `bun` into `~/.config/claude-pod/shims/`. It then prints the one line to put first
  on `PATH`. claude-pod still never edits shell rc files itself.
- Each shim:
  1. walks up from the cwd for a `claude-pod.config.json` (config only, not the git root, so
     only opted-in projects are affected);
  2. **with no config, or a config without `shims`**, finds the real binary (the next one on
     `PATH` after the shims folder) and execs it;
  3. **with a config that has `shims`**, requires the config to be trusted; untrusted, it
     refuses with the `claude-pod trust` hint rather than running on the host;
  4. **with a trusted config:** `pnpm <script>` / `pnpm run <script>` / `npm run <script>`
     where `<script>` is in `shims.host` runs the real binary on the host; everything else
     becomes `claude-pod exec --no-ports <cmd> <args…>`, with stdio and the exit code passed
     through.

  The config key:

  ```json
  { "shims": { "host": ["dev", "deploy:prod", "fetch:agent-turns"] } }
  ```

- `shims.host` is for scripts that need the host's Docker, SSH or keychain. They should run no
  package code themselves; one that needs to (a dev script, say) calls `claude-pod exec` for that
  part. A host script's files should be under `readOnly` (batch 2). `doctor` warns when one is
  not.
- Cost: each shimmed command starts a fresh container, about a second. Measure it. If it hurts,
  `exec` could join a running pod of the same project (`docker exec`), as a later batch.
- `doctor`: shows whether the shims folder is first on `PATH`.
- Tests in [test/cli.test.js](../test/cli.test.js) cover the routing:
  - no config → real binary;
  - untrusted → refused;
  - a host script → real binary;
  - anything else → `exec --no-ports`.

## Docs

INTEGRATION.md gets a section "Run the whole dev loop in a pod". It covers:

- a config using `readOnly`, fixed `ports`, `secrets` and `shims`;
- moving keys out of `.env` with `claude-pod secret set`;
- the shims `PATH` line;
- a dev script that brings up compose on the host and then runs `claude-pod exec` for the app.

The README's security model gains rows for the new protections and loses "Everything else in the
project" from "still exposed" for the paths a project now locks.

## Later, not in this plan

- A per-project Node version or image (the image is `node:24-slim` for every project).
- `exec` joining an already-running pod instead of starting a new one.
- Linux secrets through `secret-tool`.
