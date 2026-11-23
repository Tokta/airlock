# Airlock

**Run AI agents and untrusted packages in a sealed box that sees one project and nothing else.**

![Airlock](assets/cover.jpeg)

I was spending hours clicking through Claude approvals, and at some point I stopped reading them and just clicked. That is absolutely not recommended.

So I found a small repo, forked it and made it mine. Now every session I run locally goes through an orchestrator, but the work happens in a closed box: an agent gets briefed, does what it thinks is right, and comes back with a result. A reviewer agent checks it the same way, and then I give the human approval.

Then I realised a malicious npm package is the same problem as a prompt-injected agent: someone else's code, running with my permissions. So now `pnpm install`, `pnpm dev` and the tests go through the airlock too.

**Is it 100% safe?** Likely not. **Does it save me headaches?** Definitely yes.

## What it is

A small CLI that starts Docker containers ("pods") that mount only the project you launch them from. Your home folder, SSH keys, cloud credentials, browser data and other projects stay invisible.

It does two jobs:

- **Agents in a box.** Claude Code runs in a pod with `--dangerously-skip-permissions`, so it works without asking you about every step. An orchestrator hands it a task with `airlock run` and reads the result back.
- **Your dev loop in a box (opt-in).** In a project that turns it on, `pnpm`, `npm`, `node` & co. typed in your terminal, or run by the Claude session on your Mac, go to a pod by themselves. API keys come from the macOS keychain instead of a plaintext `.env`.

The pod is treated as hostile: nothing it writes is trusted by your Mac afterwards.

Unofficial: not affiliated with or endorsed by Anthropic.

## Install

Requirements: Docker (Desktop, OrbStack, Colima or Engine), Node.js 20+, and a Claude subscription.

```sh
git clone https://github.com/Tokta/airlock.git && npm install -g ./airlock   # the `airlock` command
airlock build                          # build the Docker image
claude setup-token && airlock auth     # create a login token, paste it
airlock doctor                         # check everything
```

Coming from claude-pod (the old name)? Run `airlock migrate` once; see [the reference](docs/REFERENCE.md#coming-from-claude-pod).

## Use

### Agents

```sh
cd your-project                        # a git repo
airlock claude                         # interactive Claude in the pod
airlock run --model opus --prompt-file /tmp/task.md --out /tmp/task   # headless agent run
```

`airlock run` is what an orchestrator calls: the prompt goes in on stdin, and the result lands in `/tmp/task.out`, `.err` and `.exit`. `airlock guide` prints a briefing you can hand to an agent. To wire it into an orchestrator (permissions, Docker network, ports, env), see **[INTEGRATION.md](INTEGRATION.md)**.

### Your dev loop

```sh
airlock exec pnpm install              # any command, in a fresh pod
airlock exec pnpm dev                  # with the project's ports published
```

Or let it happen without thinking about it. Opt the project in with an `airlock.config.json`:

```json
{
  "readOnly": ["scripts", "package.json", "docker-compose.yml"],
  "ports": [{ "port": 3000, "fixed": true }],
  "secrets": ["RESEND_API_KEY"],
  "shims": { "host": ["deploy:prod"] }
}
```

```sh
airlock trust                          # approve the config (a pod can't change it behind your back)
airlock secret set RESEND_API_KEY      # move the key from .env into the keychain
airlock shims                          # once per machine: prints the PATH line to add
pnpm dev                               # now runs in a pod
```

- `readOnly`: files a pod may read but never change, like the scripts your Mac will run later.
- `ports`: the dev server keeps its real port, so OAuth callbacks and cookies keep working.
- `secrets`: handed to dev-loop pods only, never to Claude's.
- `shims.host`: the few scripts that really need your Mac (Docker, SSH, deploys).

The full walkthrough is in [Run the whole dev loop in a pod](INTEGRATION.md#5-run-the-whole-dev-loop-in-a-pod).

## What it does and doesn't protect

- **Protected:** everything outside the project folder. Inside it, the files your Mac would run later (`.git/hooks`, `.git/config`, `.claude/`, `.mcp.json`, and your `readOnly` paths) are read-only, or quarantined if a pod creates them. On macOS they're also made immutable while a pod runs, so host edits to them (`git push -u`, `git config`) fail until it exits.
- **Not protected:** the rest of the project is read-write, so review the diff before you run its scripts on your Mac. The network is open by default, so a hostile pod could send the project, and its login token, anywhere; `"network": "none"` stops that but also takes Claude offline. An agent can change code that a later dev-loop pod runs with your keys. A command run by its full path, or a global CLI, still runs on your Mac.
- **Pods start from `node:24-slim`:** Node, npm, pnpm, yarn, git, curl, jq and gh. Python, compilers and other languages aren't installed yet.

Details: [docs/REFERENCE.md](docs/REFERENCE.md#security-model).

## More

- [docs/REFERENCE.md](docs/REFERENCE.md): every command, the config file, ports, login, secrets, shims, several pods, pinning Claude Code, the full security model, uninstall.
- Tests: `npm test` (uses a fake Docker, no daemon needed).

## License

MIT, see [`LICENSE`](LICENSE). Claude Code is a separate product owned by Anthropic, PBC, and is not redistributed here: `airlock build` fetches it from npm at build time. "Claude" and "Claude Code" are trademarks of Anthropic, PBC, used nominatively.
