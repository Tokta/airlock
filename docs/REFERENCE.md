# claude-pod reference

Full reference for claude-pod. For the short version, see the [README](../README.md); for setting up a project (Docker network, ports, env, agent permissions), see [INTEGRATION.md](../INTEGRATION.md).

## Contents

- [Install](#install)
- [Commands](#commands)
- [Project root and config](#project-root-and-config)
- [Ports](#ports)
- [Login](#login)
- [Running several pods](#running-several-pods)
- [Updating or pinning Claude Code](#updating-or-pinning-claude-code)
- [Security model](#security-model)
- [Reference](#reference)

## Install

Requirements: **Docker** (Desktop, OrbStack, Colima or Engine), **Node.js 20+**, and a Claude subscription (for `claude setup-token`).

```sh
npm install -g /path/to/claude-pod    # or: cd /path/to/claude-pod && npm link
claude-pod build
claude setup-token && claude-pod auth
claude-pod doctor                     # checks everything
```

`npm install -g <folder>` symlinks the folder, so a `git pull` in the clone updates the command immediately. The package is marked `private`, so it can't be published by accident. When the Dockerfile changes, launches warn you to re-run `claude-pod build`.

## Commands

| Command | What it does |
|---|---|
| `claude-pod` / `claude-pod shell [--no-ports]` | bash shell in the pod |
| `claude-pod claude [args…]` | Claude in the pod; args passed through unchanged |
| `claude-pod exec [--no-ports] <cmd> [args…]` | any command in the pod, e.g. `claude-pod exec pnpm dev`; `--no-ports` for commands that serve nothing (`exec --no-ports pnpm test`) |
| `claude-pod run …` | headless Claude task with `--print --dangerously-skip-permissions` (below) |
| `claude-pod build [--claude-version V]` | build or rebuild the image |
| `claude-pod auth [--from-env] [--remove]` | store the login token from `claude setup-token` |
| `claude-pod init` | create (and trust) `claude-pod.config.json` for the current project |
| `claude-pod trust` | review and approve a new or changed `claude-pod.config.json` |
| `claude-pod ps [--all]` / `claude-pod stop [NAME…] [--all]` | list / stop running pods |
| `claude-pod guide` | briefing for AI agents (how to delegate, read results, handle errors) + status of this project; read-only |
| `claude-pod doctor` | check Docker, image, login and project config |
| `claude-pod uninstall [--yes]` | remove the image and all claude-pod state |

Every command has `--help`. Launcher messages go to **stderr**, so stdout carries only what runs in the pod.

### `claude-pod run`

One command, no shell plumbing — designed for agents that orchestrate other agents:

```sh
claude-pod run --model opus --prompt-file /abs/scratchpad/step-6b1.md --out /abs/scratchpad/impl-6b1
```

- Runs `claude --print --dangerously-skip-permissions --output-format text [--model …]` in a fresh pod.
- Feeds the prompt on stdin — no `"$(cat …)"`, nothing in the host's process list.
- With `--out BASE`: writes `BASE.out`, `BASE.err`, `BASE.exit`, then prints `exit=<code>`. Without it, streams to stdout/stderr.
- Exits with Claude's exit code.
- `--prompt TEXT` for short prompts, `--output-format json`, `--ports` to publish the config's ports; anything after `--` goes to `claude` verbatim.
- `--prompt-file` and `--out` must be in the system temp dir, `/tmp`, `/var/tmp` (agent scratchpads live there) or a `runDirs` entry of `~/.config/claude-pod/settings.json`. `--prompt-file` may also be in the project; `--out` may not.

Because it's a single plain command, one permission rule covers every way an agent calls it — see [INTEGRATION.md](../INTEGRATION.md#2-agent-permissions).

## Project root and config

The folder mounted into the pod is found the way git finds `.git`, so launching from a subfolder or after a `cd` gives the same result:

1. the nearest folder (walking up) containing `claude-pod.config.json`;
2. else the nearest git root.

It must be a project: claude-pod refuses `/`, your home directory, anything containing your home directory, folders that look like a home (`.ssh`, `.aws`, `.gnupg`), and folders with neither `.git` nor a config. It's mounted at its **real path**, so file paths in logs and stack traces match between host and pod.

`claude-pod.config.json` is optional:

```json
{
  "network": "my-app_default",
  "ports": [3000, 3131],
  "envFile": ".env",
  "env": {
    "HOST": "0.0.0.0",
    "DATABASE_URL": "postgresql://app:${POSTGRES_PASSWORD}@postgres:5432/app"
  },
  "resources": { "pids": 4096, "memory": "4g", "cpus": 2 },
  "readOnly": ["scripts", "package.json", "Makefile"]
}
```

| Key | Meaning |
|---|---|
| `network` | Docker **bridge** network to join so the pod reaches services by name (`postgres:5432`). `"none"` cuts all networking. `host`, `container:…` and non-bridge drivers are refused. |
| `ports` | Container ports to publish on **free** `127.0.0.1` host ports, or `{"port": 3000, "fixed": true}` to keep the real port (see [Ports](#ports)). |
| `envFile` | `.env`-style file **inside the project** whose values can be used as `${VAR}` in `env`. |
| `env` | Extra environment for the pod. `${VAR}` comes from `envFile` only — never from your host environment. Unset variables are an error; `$$` is a literal `$`. |
| `resources` | `pids` (default 4096), `memory`, `cpus`. |
| `readOnly` | Project files and folders your host runs, which pods must not change (see [Project files that would run on your host](#project-files-that-would-run-on-your-host)). Paths relative to the project; no `..`, nothing under `node_modules` or `.git`. |

**The config must be approved.** The file lives in the project, which pods can write — so claude-pod only uses a config whose exact content you've approved. `init` approves what it creates; after any edit (yours or a pod's), run `claude-pod trust` to review and approve it. Interactive launches ask; unattended ones (`run` from an agent, no terminal) refuse to start. Approvals live in `~/.config/claude-pod/trust/`, which no pod can reach.

## Ports

Each port in `ports` is published on a free host port chosen at launch, bound to `127.0.0.1` only:

```
● claude-pod claude-pod-my-app-3f9a1c
  port 3000 → http://127.0.0.1:52341
  port 3131 → http://127.0.0.1:52342
```

Inside the pod, `CLAUDE_POD_PORT_3000=52341` etc. tell your app its host-side URL. These ports never clash with a dev server on your host or with other pods. `shell`, `claude` and `exec` publish ports; `run` doesn't unless you pass `--ports`, and `shell --no-ports` and `exec --no-ports` publish none. `claude-pod ps` shows the mappings.

**Fixed ports.** A dev server often needs its real port, because OAuth callbacks, auth base URLs and cookies are set to it. Mark it fixed:

```json
{ "ports": [{ "port": 3000, "fixed": true }, 3131] }
```

- **`exec` and `shell`** publish it on `127.0.0.1:3000` itself, with `CLAUDE_POD_PORT_3000=3000`. It is never moved to another port. If 3000 is taken (something answers on `127.0.0.1` or `::1`, or holds it, including another pod), the pod refuses to start: `port 3000 is in use — is the dev server already running?`. Two pods started at the same instant can both pass that check; the second then fails in `docker run` with "ports are not available".
- **`claude` and `run --ports`** publish it on a free host port, like any other entry. So an agent pod's own server never takes the real port, where it would receive OAuth redirects meant for your app and could register a service worker that outlives the pod. This does not keep agent-written code off that origin: the dev server serves whatever is in the project, including files an agent changed or added.

Use `claude-pod exec --no-ports pnpm test` (or `shell --no-ports`) for anything that serves nothing, so it can run beside `pnpm dev`.

> **Bind dev servers to `0.0.0.0` inside the pod**, not `localhost` (e.g. `"HOST": "0.0.0.0"` in `env`, `vite --host`, `next dev -H 0.0.0.0`). The host side stays `127.0.0.1`-only, so this doesn't expose anything to your LAN.

## Login

The in-pod `/login` browser flow doesn't work (the OAuth redirect is rejected), so pods use a **long-lived token**:

```sh
claude setup-token     # on the host; opens the browser, prints a token (needs a Claude subscription)
claude-pod auth        # paste it (hidden input), or: claude-pod auth < token.txt
```

This is a login for **your Claude subscription** (Pro/Max), the same plan you use on the host: usage counts against your plan's limits, and nothing is billed as API usage. It's an OAuth token (`sk-ant-oat…`), not an API key (`sk-ant-api…`).

Where it lives and who can see it:

- **The token file** is `~/.config/claude-pod/oauth-token` (mode 0600), in a folder that is never mounted into any pod. A pod can't read, change or replace that file.
- **The token itself** is handed to the pods that run Claude, `claude-pod claude` and `claude-pod run`, as the `CLAUDE_CODE_OAUTH_TOKEN` environment variable (through a private env-file, not the command line), because Claude inside the pod needs it to log in. So **anything running in those pods can read it** (`echo $CLAUDE_CODE_OAUTH_TOKEN`) and, with the network open, send it elsewhere — treat it like a password to your Claude plan. If you suspect a pod misbehaved, create a new one with `claude setup-token` and run `claude-pod auth`.
- **`claude-pod shell` and `claude-pod exec` get no token**, so a package running under `exec pnpm dev` can't read it directly. It can still write files that a later `claude` or `run` pod of the same project loads (its `node_modules`, the pod's `~/.claude`), and code planted there runs with the token. `claude` started by hand in a shell pod is not logged in; use `claude-pod claude` instead.

It doesn't refresh or rotate, so parallel pods can't log each other out — no shared credentials file, no refresh races.

## Running several pods

Pods are independent: unique names (`claude-pod-<project>-<id>`), free ports, per-project state, and a token that doesn't rotate. `claude-pod ps` lists them; `claude-pod stop` stops the current project's pods (or `--all`, or by name). If a launcher is killed (even with `kill -9`), a small watchdog stops its pod within seconds and quarantines anything it planted. If the watchdog is killed too (e.g. a harness that kills the whole session), the pod keeps running until you `claude-pod stop` it.

Pods of the **same project** share its working tree and `.git`, so parallel agents committing in one repo can collide. Per-pod git worktrees are planned for v2.

## Updating or pinning Claude Code

```sh
claude-pod build                          # refetch the latest Claude Code
claude-pod build --claude-version 2.0.0   # pin (also: CLAUDE_CODE_VERSION=2.0.0)
```

The image is intentionally minimal: `node:24-slim` + `git` + `curl` + `less` + `jq` + `gh` + `pnpm` through corepack + Claude Code. A project's `packageManager` pin decides the pnpm version; without one, corepack fetches the latest pnpm on the project's first launch and keeps using it (it is cached in `pkg-cache/`). Add toolchains your projects need by editing the `Dockerfile` and re-running `claude-pod build`. `build` records the image ID; launches refuse a `claude-pod` tag that points at any other image.

## Security model

The pod is treated as hostile: assume the agent inside was prompt-injected. Two rules follow — the pod can't reach beyond the project, and **nothing the pod writes is trusted by the host later**.

### What a pod gets

One `docker run` (see `buildRunArgs` in [`src/docker.js`](../src/docker.js)):

- the project folder, read-write, at its real path — **except** the files below, which are read-only;
- its own project's state dir `~/.claude-pod/pods/<project>/` (sessions, Claude settings, package caches) — never another project's;
- the login token (`claude` and `run` only) and config env through a private env-file (not on the command line, not in the docker client's environment);
- your user's uid (`--user`), `--cap-drop=ALL`, `no-new-privileges`, `--pids-limit`, `--init`, optional memory/CPU caps;
- outbound network (or none), and only the ports you configured, on `127.0.0.1`.

### Project files that would run on your host

Some project files are executed or loaded by tools on your host later. A pod must not be able to plant them:

| Path | Why | Protection |
|---|---|---|
| `.git/hooks/` | run by git on commit/push | read-only (created if missing) |
| `.git/config` | `core.fsmonitor` runs on `git status`; hooksPath, filters, aliases | read-only |
| `.git/config.worktree` | overrides `.git/config` once `git sparse-checkout` turns `extensions.worktreeConfig` on | read-only if present; quarantined if created |
| the folder `core.hooksPath` names (e.g. `.githooks/`) | run by git on commit/push instead of `.git/hooks/` | read-only (created if missing); pod refuses to start if it is a symlink, outside the project, or the project itself. Every value counts: from `.git/config`, `.git/config.worktree`, your global and system git config and the files they include, and from the repo above when the project is a folder of a monorepo. A relative value in your global config (`core.hooksPath = .githooks`) applies to every repo, so that folder is created and locked in every project you launch. Only that folder is locked: a hook that calls other project files (husky's `.husky/_` stubs run `.husky/<hook>`) still runs whatever the pod wrote there |
| `.claude/` | settings, hooks, agents of the Claude session orchestrating from the host | read-only (created if missing) |
| `.mcp.json` | MCP servers started by host Claude | read-only if present, quarantined if a pod creates it |
| `.envrc` | run by direnv on `cd` | read-only if present, quarantined if created |
| `.vscode/`, `.idea/` | editor tasks and settings | read-only if present, quarantined if created |
| `.git` itself | could be swapped for a fresh repo with its own hooks | mounted as its own mount point, so it can't be moved or replaced |
| a file `.git/config` (or your global git config) includes (`[include]`, `[includeIf]`) | host git reads it like `.git/config` | pod refuses to start if it is inside the project, unless it is one of the read-only paths in this table or under one |
| `.git` as a file, when the project itself is a linked worktree or a submodule | says where git reads hooks and config | read-only; pod refuses to start if it points inside the project. The main repo's config is read for `core.hooksPath`. This covers the project's own `.git` file only, not the submodules inside it (see below) |
| `.git/commondir` | redirects where git reads config and hooks | pod refuses to start if present; quarantined if created |
| `.git` (in a non-git project) | a new repo with hooks | quarantined if created |
| paths in the config's `readOnly` (e.g. `scripts/`, `package.json`, `Makefile`) | scripts you run on the host | read-only if present, quarantined if created (a missing folder is quarantined whole); the folders above it are mount points, so they can't be swapped either; pod refuses to start if one is a symlink or is reached through one |

"Quarantined" means renamed to `<name>.claude-pod-quarantine-<timestamp>` after the run, with a warning. This also happens when the launcher is killed or crashes (the watchdog does it). If the watchdog can't run either (power loss, a harness that kills every process of the session), the next launch in that project does it before anything else — so until then the planted file is still there, and files you create yourself in that project in the meantime get quarantined too (renamed, never deleted). `claude-pod doctor` lists such interrupted runs. The same goes for a missing `readOnly` path that you create yourself during a run (a `git pull` that adds a `Makefile`, say): it is renamed at the end too.

**macOS: read-only files are locked while a pod runs.** On a case-insensitive file system a pod can write a read-only *file* through another spelling of its name (`.git/CONFIG`, `.MCP.json`); folders are not affected. So for the length of the run claude-pod also makes each such file (`.git/config`, `.mcp.json`, `.envrc`, a worktree's `.git` file, `readOnly` files) immutable (`chflags uchg`). No pod can write, rename, delete or hard-link it then, and neither can host tools, **including yours**: while any pod of the project runs, `git push -u`, `git remote add`, `git config`, `claude mcp add`, or saving a listed `package.json` in your editor fail with "Operation not permitted". The launch prints which files are locked. They are unlocked when the last running pod of the project exits, or by the watchdog if the launcher is killed. If both die (power loss), the next launch in that project unlocks them, or run `chflags nouchg <file>`. A file you made immutable yourself is left as it is.

As a second line, each of those files is also copied to `~/.config/claude-pod/` at launch. If it still changed, is gone, has a second hard link or a new mode after the run, the copy is put back and the changed one is kept as `<name>.claude-pod-quarantine-<timestamp>-<random>`, with a warning. On Linux the read-only mount is enough, and none of this happens.

A protected file with a second hard link stops the pod from starting: the other name is writable.

A file in `readOnly` is mounted as it was at launch. If a host tool replaces it by writing a new file and renaming it (many editors, `npm install` on `package.json`), a running pod keeps the old version until it restarts. A pod can't change a listed `package.json` at all, so `pnpm add` fails there; leave it out if pods should add dependencies. If any of these paths is a symlink, or resolves outside the project, the pod doesn't start: something planted it.

Git inside the pod still works for commits (identity comes from your global `user.name`/`user.email`), but `git config` writes to the repo fail — use `git -c key=value …` for one-off settings.

### What is still exposed

- **Everything else in the project**, read-write: source, `.env`, test configs, nested folders, and `package.json` scripts, `Makefile` and the like unless you list them under `readOnly`. **Review the diff before running project scripts on your host** (`npm test`, `make`, …) — a hostile pod can put anything in them, or in the files they call.
- **Git beyond the top-level hooks and config.** The pod can write the git index and create nested repositories in subfolders (which the index can register as submodules), and host git reads their settings too. The same goes for existing submodules and linked worktrees: their config and hooks under `.git/modules/` and `.git/worktrees/`, and each submodule's `.git` file, are pod-writable, and a host `git status` runs a submodule's `core.fsmonitor`. After an unattended run, inspect with hooks and fsmonitor off until you've reviewed the changes — see [After an unattended run](../INTEGRATION.md#after-an-unattended-run).
- **The network.** Outbound is open by default, so a pod can send the project (and the login token) anywhere. `"network": "none"` or `NET=none` cuts it, but also takes Claude offline.
- **The login token** — see [Login](#login).
- **This project's pod history and caches** in `~/.claude-pod/pods/<project>/`: a pod can read and alter its own project's past sessions, Claude settings and package caches, so it can poison a package that the next pod of the project installs. The host never reads the caches, but it does run what lands in `node_modules` (`pnpm dev` on the host): the same trust as the rest of the working tree.
- **Hardlinks.** A hardlink inside the project to a file elsewhere on the same filesystem is reachable through the mount. It only matters for projects from untrusted sources.

### What you shouldn't allow an orchestrator

Auto-approve only `Bash(claude-pod run:*)` and the read-only `Bash(claude-pod guide:*)`. `claude-pod trust`, `auth`, `uninstall`, `stop` and plain `claude-pod` should stay behind a prompt: `trust` deliberately needs a terminal, and there's no `--yes`.

### Environment overrides

```sh
NET=none claude-pod            # no networking at all
MEMORY=4g CPUS=2 claude-pod    # cap memory/CPU for untrusted builds
PIDS=512 claude-pod            # lower the process cap
```

### Side effects outside the project folder

- `~/.config/claude-pod/` — host-only: login token, config approvals, built image ID, settings, and short-lived private run files.
- `~/.claude-pod/pods/` — one Claude state dir per project (sessions, settings). Its `pkg-cache/` folder holds the project's package-manager caches (corepack's pnpm downloads, the pnpm store and metadata cache, the npm cache), so pods don't download everything again on every launch. Each project keeps its own copy, typically tens of MB. `claude-pod uninstall` removes them, and deleting a project's `pkg-cache/` is always safe. A project's `env` can point any of `COREPACK_HOME`, `pnpm_config_store_dir`, `pnpm_config_cache_dir` and `npm_config_cache` elsewhere.
- The `claude-pod` Docker image (~700 MB), the `node:24-slim` base, and build cache.
- The global `claude-pod` command (a symlink created by `npm install -g`).
- In the project: an empty `.claude/` and `.git/hooks/` if they were missing, and any quarantined files. On macOS, while a pod runs, the immutable flag on its read-only files (see above).
- While running: one container per pod, one watchdog process, and published ports on `127.0.0.1`.

No `sudo`, no writes to your existing `~/.claude/`, shell rc files, or system paths.

**node_modules from before the pnpm cache.** pnpm records its store in `node_modules/.modules.yaml`. When the store moves (after upgrading claude-pod, or switching between a host and a pod `pnpm install`), the next `pnpm install` asks to remove `node_modules`, and without a terminal it waits forever. Delete `node_modules` (and a leftover `.pnpm-store` in the project) or run `claude-pod exec pnpm install --config.confirm-modules-purge=false` once. For a tree shared by host and pod, a `storeDir` in `pnpm-workspace.yaml` wins over claude-pod's setting, so both sides agree.

## Reference

### Platforms

- **macOS** with Docker Desktop, OrbStack or Colima — primary target.
- **Linux** with Docker Engine or Desktop.
- **Windows** via WSL2 only.

Running as root on the host makes Claude refuse `--dangerously-skip-permissions` (the pod runs as your user) — use a regular user.

### Uninstall

```sh
claude-pod uninstall        # image + ~/.claude-pod + ~/.config/claude-pod, after confirmation
npm uninstall -g claude-pod # the command itself
```

### Development

```sh
npm test    # node:test; uses a fake docker, no daemon needed
```

### License and trademarks

MIT — see [`LICENSE`](../LICENSE).

Claude Code is a separate product owned by Anthropic, PBC, and is **not** redistributed by this project — `claude-pod build` fetches it from npm at build time. This project is not affiliated with, endorsed by, or sponsored by Anthropic, PBC. "Claude" and "Claude Code" are trademarks of Anthropic, PBC, referenced here nominatively.
