# Using airlock on a project

How to wire a project into airlock: services on a Docker network, ports, secrets, and letting
agents launch pods without permission prompts. Assumes you've done the one-time setup from the
[README](README.md#install): `npm install -g`, `airlock build`, `claude setup-token` +
`airlock auth`.

---

## 1. Create the project config

```bash
cd ~/projects/your-app
airlock init
```

This writes `airlock.config.json` at the project root (the git root) and approves it. It
pre-fills `network` when it finds your Docker Compose network (`<folder>_default`) and `envFile`
when there's a `.env`. Then fill in the rest, for example:

```json
{
  "network": "ops-olive_default",
  "ports": [3000, 3131],
  "envFile": ".env",
  "env": {
    "HOST": "0.0.0.0",
    "DATABASE_URL": "postgresql://app_user:${APP_USER_PASSWORD}@postgres:5432/ops_olive_database",
    "MIGRATION_DATABASE_URL": "postgresql://ops_olive:${POSTGRES_PASSWORD}@postgres:5432/ops_olive_database"
  }
}
```

and approve the edit:

```bash
airlock trust     # shows the file, asks y/N
```

- **`network`** — lets the pod reach your services by name (`postgres:5432`). Find it with
  `docker network ls`. Must be a bridge network (Compose networks are); the stack must be up
  (`docker compose up -d`) before you launch a pod.
- **`env`** — ⚠️ host `.env` values using `localhost` don't resolve inside the pod; inject
  container-reachable URLs here. `${VAR}` comes from `envFile` only (a file inside the project) —
  never from your shell environment. An unset variable is an error, so a missing secret fails at
  launch rather than as a DB error.
- **`ports`** — container ports; each gets a free `127.0.0.1` host port per pod (printed at launch,
  and available in the pod as `AIRLOCK_PORT_<port>`). A dev server whose OAuth callbacks or
  cookies need its real port uses `{"port": 3000, "fixed": true}` instead: `exec` and `shell`
  publish it on `127.0.0.1:3000` and refuse to start while 3000 is busy; agent pods get a free
  port for it ([Ports](docs/REFERENCE.md#ports)).

Commit the config — it holds no secrets, only references to them. Check with `airlock doctor`.

**Why the approval step:** the config sits in the project, which pods can write. Without it, one
hostile run could edit the config so the *next* pod joins a more powerful network or pulls in more
secrets. Any change — yours, a teammate's via `git pull`, or a pod's — must be approved again with
`airlock trust`, and unattended runs refuse to start until it is. If an agent run fails with
"is new or has changed since you approved it" and you didn't change the config, **look at
`git diff airlock.config.json` before trusting it.**

---

## 2. Agent permissions

Agents launch pods in many shapes — with `P=… &&`, after `cd …;`, with `"$(cat …)"`, redirects and
`echo exit=$?`. Each shape is a different command string, so path-based rules like
`Bash(./scripts/airlock.sh:*)` keep missing. `airlock run` removes the need for all of that
plumbing, so one rule covers it. In the project's `.claude/settings.json`:

```json
{
  "permissions": {
    "allow": ["Bash(airlock run:*)", "Bash(airlock guide:*)"]
  }
}
```

Only `run` and the read-only `guide`. Keep `airlock trust`, `auth`, `uninstall` and friends behind a prompt: an
orchestrator that could approve configs itself would defeat the approval step.

Then point your agents at it — e.g. in `CLAUDE.md` or the orchestrating skill. `airlock guide`
prints the full agent briefing (exact command form, how to read results, what each error means
and whether to stop and ask you) plus a live status of the project, so a short pointer is enough:

```markdown
## Delegating to a sandboxed Claude

Before delegating, run `airlock guide` once and follow it. In short:

Run sub-agents with exactly this form — one command, absolute paths, no `cd`, no variables,
no `$(…)`, no redirects:

    airlock run --model opus --prompt-file <scratchpad>/step.md --out <scratchpad>/step

Both paths must be in your scratchpad (a temp dir), never inside the project.
It writes `<scratchpad>/step.out`, `.err` and `.exit`, prints `exit=<code>`, and exits with that
code. Read the `.out` file for the result. If it fails because the config is untrusted, stop and
tell the user — never try to approve it yourself.
```

Before → after:

```bash
# before
P=/private/tmp/…/scratchpad && ./scripts/airlock.sh claude --print --dangerously-skip-permissions \
  --model opus --output-format text "$(cat $P/step-implementer-6b1.md)" > $P/impl-6b1.out 2> $P/impl-6b1.err; \
  echo "exit=$?" >> $P/impl-6b1.out

# after
airlock run --model opus --prompt-file /private/tmp/…/scratchpad/step-implementer-6b1.md --out /private/tmp/…/scratchpad/impl-6b1
```

The exit code now lives in `impl-6b1.exit` (and on stdout as `exit=0`), not appended to `.out`.

If your scratchpads live somewhere other than a temp dir, allow that folder host-side in
`~/.config/airlock/settings.json`:

```json
{ "runDirs": ["/Users/you/agent-scratch"] }
```

---

## 3. Migrating from the per-project scripts

If the project has the old `scripts/airlock.sh` / `scripts/airlock-auth.sh`:

1. Move its `NETWORK`, ports and injected env into `airlock.config.json` (step 1), then
   `airlock trust`.
2. Delete both scripts, and any `pod` / `pod:auth` entries in `package.json`
   (or point them at `airlock` / `airlock auth`).
3. Replace the old permission rules with `Bash(airlock run:*)` and `Bash(airlock guide:*)` (step 2).
4. Update CLAUDE.md / skills that mention `./scripts/airlock.sh`.
5. Once per machine: `claude setup-token` + `airlock auth` (replaces the Keychain export; it
   also deletes the old copied login from `~/.airlock`).

---

## 4. (Optional) pnpm monorepos: `node_modules` for host *and* pod

Host (macOS) and pod (Linux) share the same `node_modules`, so native packages (esbuild, sharp,
next-swc, …) need binaries for both. In `pnpm-workspace.yaml`, then a clean `pnpm install`:

```yaml
supportedArchitectures:
  os: [current, linux, darwin]
  cpu: [current, arm64]
```

**One `dev` script for host and pod:** `docker compose` isn't available inside the pod. Gate it on
the `AIRLOCK` marker:

```bash
[ -z "${AIRLOCK:-}" ] && docker compose up -d   # host only; in the pod the DB is already up
```

---

## 5. Run the whole dev loop in a pod

Steps 1–4 sandbox the agents. The dev loop itself (`pnpm install`, `pnpm dev`, tests, builds)
still runs on your host, where a malicious package can read `~/.ssh`, cloud keys and every other
project. In a project that opts in, package commands run in a pod instead, whether you typed them
or the host Claude session did.

**The config.** Everything below in one place:

```json
{
  "network": "my-app_default",
  "ports": [{ "port": 3000, "fixed": true }],
  "envFile": ".env",
  "env": {
    "HOST": "0.0.0.0",
    "DATABASE_URL": "postgresql://app:${POSTGRES_PASSWORD}@postgres:5432/app"
  },
  "secrets": ["RESEND_API_KEY", "STRIPE_SECRET_KEY"],
  "readOnly": ["package.json", "pnpm-lock.yaml", "scripts", "docker-compose.yml"],
  "shims": { "host": ["dev"] }
}
```

- **`ports`**: the dev server keeps its real port, so OAuth callbacks and cookies still work.
  `exec` refuses to start while 3000 is busy, rather than moving it.
- **`secrets`**: API keys come from the macOS keychain, not from `.env` (below).
- **`readOnly`**: the files your host runs. The `dev` script runs on the host, so `package.json`
  (where it's defined; airlock refuses host scripts without it), the lockfile, the compose file
  and the scripts it calls must not be writable by a pod.
- **`shims`**: `pnpm`, `npm`, `node` & co. typed on the host go to a pod, except `pnpm dev`.

Approve it with `airlock trust`.

**Move the keys out of `.env`.** For each real secret in `.env`:

```bash
airlock secret set RESEND_API_KEY     # hidden input; or: airlock secret set RESEND_API_KEY < file
```

then delete it from `.env` and add its name to `"secrets"`. `airlock secret list` shows what's
stored, and `airlock doctor` shows which configured secrets are missing. Keys reach pods you
start with `airlock shell` or `airlock exec` only: never `claude` or `run` pods, and never
the pods the shims start (every `pnpm install` would hand them to postinstall scripts).
Local-only values, like the compose database password above, can stay in `.env`.

**Put the shims first on `PATH`.** Once per machine:

```bash
airlock shims
```

It prints the line for your `~/.zshrc` or `~/.bashrc`:

```bash
export PATH="$HOME/.config/airlock/shims:$PATH"
```

Open a new terminal (and restart the host Claude session, which uses the same `PATH`), then check
with `airlock doctor`. Now `pnpm install` and `pnpm test` in this project run as
`airlock exec --no-ports …`, about half a second slower each. `node src/seed.js` goes to a pod
too; `node scripts/check.js` runs on the host, since `scripts` is read-only, and so do global CLIs
and airlock itself. Other projects are untouched.

**A dev script that brings up compose on the host, then the app in a pod.** `docker compose` needs
the host's Docker, so the `dev` script stays on the host (it's in `shims.host`) and runs only the
app in a pod:

```json
{ "scripts": { "dev": "./scripts/dev.sh" } }
```

```bash
#!/bin/sh
# scripts/dev.sh: runs on the host (shims.host), so it runs no package code itself.
set -e
docker compose up -d --wait
exec airlock exec pnpm exec next dev -H 0.0.0.0 -p 3000
```

`pnpm dev` doesn't use your host pnpm: airlock reads the `dev` script from `package.json` and
runs it with `/bin/sh` in the project root. It starts the database on the host and the app in a
pod on `http://127.0.0.1:3000`, with the project's secrets (that `airlock exec` is explicit).
Run `pnpm test` beside it in another terminal: it goes through `exec --no-ports`, so it doesn't
fight over 3000. Tests that need a secret: `airlock exec --no-ports pnpm test`.

What this doesn't cover: a command run by its full path (`/usr/local/bin/node`), tools the shims
don't know, a global CLI and the project files it loads (`eslint` reading `eslint.config.js`), and
whatever a `shims.host` script runs. An agent pod can still change the code a later `exec` runs
with the secrets loaded, so review the diff after an agent run, and after one you don't trust,
delete `node_modules` and the project's package cache before reinstalling. See
[Secrets](docs/REFERENCE.md#secrets) and [Host shims](docs/REFERENCE.md#host-shims).

---

## After an unattended run

The pod has **no git or GitHub credentials** by design. Let the agent commit locally (the project
is bind-mounted, so commits appear in your host repo instantly), then review and push from the host:

```bash
# Review with git's hook/fsmonitor/submodule features off: a pod can't change the top-level hooks
# or config, but it can create nested repos in subfolders and register them in the index.
alias gsafe='git -c core.fsmonitor=false -c core.hooksPath=/dev/null -c submodule.recurse=false -c diff.ignoreSubmodules=all'
gsafe status                    # anything airlock quarantined shows up as *.airlock-quarantine-*
gsafe log -p --stat origin/main..HEAD   # what the agent committed — incl. package.json scripts,
                                        # Makefiles and test configs you're about to run on your host
gsafe ls-files --stage | grep '^160000'           # submodule entries: should be only ones you expect
find . -path ./node_modules -prune -o -name .git -not -path ./.git -print   # nested repos: ditto
git push -u origin <branch>
gh pr create --fill
```

Top-level git hooks, `.git/config` and `.git` itself are protected inside the pod, so pushing
can't trigger anything a pod planted there. Unexpected new submodules or nested `.git` folders
are the thing to look for before running plain `git` commands.

---

## Gotchas

- **Start autonomous runs from a clean working tree.** Agents often `git add -A`, sweeping unrelated
  uncommitted files into their commits.
- **Parallel pods on one project share the working tree and `.git`.** Concurrent commits can
  collide; per-pod worktrees are planned for v2. Don't run git on the host mid-commit either.
- **`git config …` fails inside the pod** (`.git/config` is read-only). Commits use your global
  git identity; use `git -c key=value …` for anything else.
- **Editing `.claude/`, `.mcp.json`, `.envrc`, `.vscode/` from inside the pod fails** (read-only),
  and creating them gets them quarantined. Edit those on the host.
- **Confirm you're in the pod:** `echo "$AIRLOCK"; uname -s` prints `1` and `Linux` inside it.
- **First interactive `airlock claude --dangerously-skip-permissions`** shows a one-time
  "Bypass Permissions mode" `y/N` in the terminal. Accept it; it persists for that project.
- **The pod can read your project's `.env`** and has outbound internet. It cannot see your home
  dir, SSH keys, Keychain, other repos, other projects' pod history, or your `gh` token.
- **Running from a git worktree** as the project: its `.git` file points into the main repo, which
  is not mounted, so git commands inside the pod fail there. Launch from the main checkout for now.
