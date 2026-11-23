# Dev box — run a project's whole dev loop in a pod

**Status:** Not started
**Created:** 2026-11-15

## Why

Airlock treats the pod as hostile because the agent inside may be prompt-injected. A
malicious npm package is the same threat: code that runs with the project's permissions and
should see nothing else. Today the pod contains agents, but the dev loop still runs on the host:
`pnpm install`, `pnpm dev`, tests and builds. A bad package installed that way can read
`~/.ssh`, cloud keys, browser data and every other project.

The goal: in a project that opts in, every package command runs in a pod, whether a person
typed it or the host Claude session did, with the same protections the agent pods already have.
`airlock exec pnpm dev` already works. What is missing is below, in order.

The guard is there to stop accidents and narrow what a package can reach. Someone who calls
`/usr/local/bin/node` by its full path on the host gets past it; that is accepted.

## [DONE] Batch 1 — two security gaps (do first; both stand on their own)

### The login token reaches only pods that run Claude

`launch()` adds `CLAUDE_CODE_OAUTH_TOKEN` to every pod's env file
([src/launch.js](../src/launch.js), `podEnv`). A package running under `exec pnpm dev` can read
it and, with the network open, send it out.

- Pass the token only when `usesClaude` is true, which means `claude` and `run`. `shell` and
  `exec` get no token.
- `shell` users who start `claude` by hand get the existing "not logged in" path. Its message
  points at `airlock claude`.
- `docs/REFERENCE.md` "Login", `AUTH_HELP` in [src/commands/auth.js](../src/commands/auth.js) and
  `airlock guide`: say which commands carry the token.
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
- `docs/REFERENCE.md` "Project files that would run on your host": add the row.

## [DONE] Batch 2 — `readOnly` paths in the config

Project scripts the host runs (`scripts/deploy.sh`, `package.json` scripts, `Makefile`) are
pod-writable today. `docs/REFERENCE.md` lists that under "What is still exposed". Let the project name
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

## [DONE] Batch 2b — gaps the batch 1 and 2 reviews found (do before batch 3)

- **Case-insensitive host defeats every file-type read-only mount (critical; existed before
  batch 2).** On macOS Docker Desktop, `echo x >> .git/CONFIG` or `> .MCP.json` from a pod
  writes the host file: a different-case name gets its own dentry in the VM, which is not the
  mount point. Folder mounts are not affected (`.CLAUDE/x` gives EROFS). It hits `.git/config`
  (fsmonitor → code on the host), `.git/config.worktree`, `.mcp.json`, `.envrc` and `readOnly`
  file entries. Options: before/after integrity check (hash + size + inode, kept in the
  host-only pending record, checked in `quarantineCreated` and `sweepRecord`; restore from a
  host-only copy and warn), or mount the parent folder instead where that is possible. Prove the
  fix in real Docker on macOS.
  **Chosen (with the user):** those files are made immutable (`chflags uchg`) while any pod of the
  project runs, refcounted across pods and cleared by the watchdog or the next launch after a
  crash; host edits to them fail meanwhile. The before/after copy-and-restore stays as a second
  line. Proven in Docker: alias writes, renames and hard links get EPERM.
- `[include]` in `.git/config` pointing at a pod-writable file: host git follows it, our
  hooksPath read does not. Refuse (or warn) when an include target is inside the project.
- Project root in a subfolder of a git repo (monorepo): the hooksPath check never runs. Look
  upward for the repo's `.git/config`.
- `.git/config.worktree` is locked but hooksPath is not read from it when
  `extensions.worktreeConfig` is on.
- Quarantine message for a missing parent folder names the folder, not the `readOnly` entry
  under it.

## [DONE] Batch 3 — fixed ports, and `exec --no-ports`

Agents want random free ports so parallel pods never clash. A dev server usually needs its real
port, because OAuth callbacks, auth base URLs and cookies are set to it.

- A `ports` entry may be a number (random host port, as today) or `{ "port": 3000, "fixed": true }`.
  A fixed entry publishes on `127.0.0.1:3000`. If that port is busy, the pod refuses to start
  with a clear message: "port 3000 is in use — is the dev server already running?". It never
  falls back to a random port.
- `exec --no-ports`: no ports published at all. The shims (batch 6) always use it, so
  `pnpm test` beside a running `pnpm dev` never fights over 3000.
- `AIRLOCK_PORT_<n>` stays as it is (equal to `n` for a fixed port).
- **Chosen (with the user, after review):** only the dev-server paths, `exec` and `shell`, publish
  a fixed port as itself and refuse when it is busy. `claude` and `run --ports` publish it on a
  random port, so a hostile agent's own server never takes the real origin (OAuth redirects,
  service workers). `shell --no-ports` exists too. A busy check counts a listener on 127.0.0.1 or
  ::1, or a held port; EACCES below 1024 is left to Docker.
- Tests: [test/config.test.js](../test/config.test.js) for the new shape;
  [src/ports.js](../src/ports.js) maps fixed ports without probing, and a busy fixed port
  throws.

## [DONE] Batch 4 — package-manager caches that outlive a pod

`HOME` in the pod is ephemeral, so every pod starts with an empty pnpm store and corepack
cache. When a project pins a different pnpm in `packageManager` than the image's 12.6.0, corepack
downloads it on every launch, and every `pnpm install` downloads everything again.

- Per project, `~/.airlock/pods/<project>/cache/` (inside the state dir already mounted at
  `~/.claude`). Set `COREPACK_HOME`, `npm_config_store_dir` (pnpm) and `npm_config_cache` (npm)
  to folders under it.
- It is pod-writable, so a pod can poison it, but only for later pods of the same project, which
  already share the working tree. Nothing on the host reads it.
- `docs/REFERENCE.md` "Side effects outside the project folder": mention it, and that `airlock uninstall` removes it.
- **As built (after review):** the folder is `pkg-cache/` (Claude Code owns `cache/`). pnpm 11+
  reads `pnpm_config_store_dir` and needs `pnpm_config_cache_dir` to install offline;
  `npm_config_store_dir` is set only for a root `packageManager` pin of pnpm 10 or older, because
  npm warns about it. The variables go through the env-file, so a config's `env` can move them.
  `readRegularFile` now checks the opened descriptor (a pod could swap in a FIFO).
- **Found, not fixed:** the image's `corepack prepare pnpm@12.6.0` lands in `/root/.cache`, which
  the pod user can't read, so pods without a pin fetch the latest pnpm on first launch. Fix in the
  Dockerfile (a world-readable prepared copy, or `npm i -g pnpm@…`).

## [DONE] Batch 5 — secrets from the host keychain

A dev server needs API keys. Today they sit in a plaintext `.env` in the project, which every pod
and every host process can read. Let the launcher fetch them at start-up instead:

```json
{ "secrets": ["ANTHROPIC_API_KEY", "RESEND_API_KEY"] }
```

- `airlock secret set NAME`: hidden input, reusing `readSecret` from
  [src/prompt.js](../src/prompt.js), or piped on stdin. It stores a generic password with
  service `airlock` and account `<project key>/<NAME>`. The project key is the same one
  `projectStateDir()` uses, so one project can never read another's secrets, whatever its config
  says. Also `secret list` (names only, never values) and `secret rm NAME`.
- `security add-generic-password -U -s airlock -a <account> -w` reads the value from its own
  prompt, never from argv. Check whether that prompt can be fed from our hidden input without
  the value appearing in `ps`. If it cannot, write the value through `security -i` on stdin.
- Launch: for each name in `secrets`, `security find-generic-password -s airlock -a <account> -w`.
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
- **As built (after review, with the user):** `security -i` reads `add-generic-password … -X <hex>`
  on stdin (checked once against the real keychain with a throwaway entry). `/usr/bin/security` by
  absolute path; tests preload `test/fixtures/fake-keychain.js`. Values are printable ASCII; only
  exit 44 means "not stored". `secret list --all` finds a moved project's entries. The docs say
  plainly what this doesn't do: an agent pod can change what a later `exec` runs with the keys,
  and any host process running as you can read them.

## [DONE] Batch 6 — host shims: package commands go to the pod

**As built:** [src/shim.js](../src/shim.js), [src/commands/shims.js](../src/commands/shims.js),
tests in [test/shims.test.js](../test/shims.test.js). It differs from the plan below in these ways, after two reviews in real
Docker and the user's decisions:
- `node <file>` is routed by where the file is. It goes to the pod when the file is pod-writable in an opted-in project:
  every symlink on the way is checked, and `readOnly` counts only if every running pod has it too. Global CLIs,
  airlock and locked scripts run on the host, with the real path that was checked.
- Airlock runs `shims.host` scripts itself, from a `readOnly` root `package.json`, with `/bin/sh` and no host pnpm
  or npm. `npm start/stop/test` count as scripts too.
- Shim pods get no keychain secrets and print no banner. They launch in-process.
- The opt-in is sticky in the trust record. `init` won't end it, `--forget` needs a terminal and the config to be gone,
  and `trust` warns before turning the shims off (for a nested config too).
- The launchers use the absolute node that wrote them and skip relative PATH entries and the shims folder under any
  spelling. They give host children the shims back, and keep IPC fds.
- A `readOnly` path that a pod already running at approval time could still write (one started under an older config)
  is fingerprinted at approval. If it changed by the time that pod is gone, the shims refuse it until `airlock trust`
  approves the new content. The fingerprint is kept, under any spelling, until it is checked or approved. `trust` names
  newly-`readOnly` paths, since approving them approves their current content.
- Speed: outside opted-in projects, the launchers exec the real tool without starting node (-ef against an index of
  opted-in roots that `trust` keeps). `node` costs about 0.08 s per call, because it is routed by its file. Host
  children keep the shims only in an opted-in project.

So that nobody has to remember `airlock exec`, in a person's terminal or in the host Claude
session (which uses the same `PATH`):

- `airlock shims` writes small launchers for `pnpm`, `npm`, `npx`, `node`, `tsx`, `yarn`,
  `bunx` and `bun` into `~/.config/airlock/shims/`. It then prints the one line to put first
  on `PATH`. Airlock still never edits shell rc files itself.
- Each shim:
  1. walks up from the cwd for a `airlock.config.json` (config only, not the git root, so
     only opted-in projects are affected);
  2. **with no config, or a config without `shims`**, finds the real binary (the next one on
     `PATH` after the shims folder) and execs it;
  3. **with a config that has `shims`**, requires the config to be trusted; untrusted, it
     refuses with the `airlock trust` hint rather than running on the host;
  4. **with a trusted config:** `pnpm <script>` / `pnpm run <script>` / `npm run <script>`
     where `<script>` is in `shims.host` runs the real binary on the host; everything else
     becomes `airlock exec --no-ports <cmd> <args…>`, with stdio and the exit code passed
     through.

  The config key:

  ```json
  { "shims": { "host": ["dev", "deploy:prod", "fetch:agent-turns"] } }
  ```

- `shims.host` is for scripts that need the host's Docker, SSH or keychain. They should run no
  package code themselves; one that needs to (a dev script, say) calls `airlock exec` for that
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

## [DONE] Docs

**As built:** INTEGRATION.md section 5 "Run the whole dev loop in a pod" and a README pointer to it. REFERENCE got its
"Host shims" section and the "still exposed" rows with Batch 6. "Everything else in the project" stays, limited to what
isn't under `readOnly`.

INTEGRATION.md gets a section "Run the whole dev loop in a pod". It covers:

- a config using `readOnly`, fixed `ports`, `secrets` and `shims`;
- moving keys out of `.env` with `airlock secret set`;
- the shims `PATH` line;
- a dev script that brings up compose on the host and then runs `airlock exec` for the app.

The security model in `docs/REFERENCE.md` (and the README's short "What it does and doesn't protect") gains rows for the new protections and loses "Everything else in the
project" from "still exposed" for the paths a project now locks.

## Later, not in this plan

- A per-project Node version or image (the image is `node:24-slim` for every project).
- `exec` joining an already-running pod instead of starting a new one.
- Linux secrets through `secret-tool`.
