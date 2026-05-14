```
 ██████╗ ██╗   ██╗████████╗██████╗  ██████╗ ███████╗████████╗
██╔═══██╗██║   ██║╚══██╔══╝██╔══██╗██╔═══██╗██╔════╝╚══██╔══╝
██║   ██║██║   ██║   ██║   ██████╔╝██║   ██║███████╗   ██║   
██║   ██║██║   ██║   ██║   ██╔═══╝ ██║   ██║╚════██║   ██║   
╚██████╔╝╚██████╔╝   ██║   ██║     ╚██████╔╝███████║   ██║   
 ╚═════╝  ╚═════╝    ╚═╝   ╚═╝      ╚═════╝ ╚══════╝   ╚═╝   
```

# outpost

> Run Claude Code as a daemon on a server you don't sit in front of. Talk to it from your phone.

A Telegram client to a headless Claude Code agent. One long-running `claude` session on the host, supervised by a small daemon, with Telegram as the front door. Drop in, drop out, pick back up days later — the agent's been waiting.

## The 2026-06-15 thing

Starting **2026-06-15**, `claude -p` (non-interactive / "programmatic" mode) moves into a separate billing bucket — small, metered, and disjoint from the Claude subscription. Interactive `claude` sessions stay on the subscription.

So outpost stopped spawning `claude -p` per message. Now it boots a single `claude --channels server:outpost-channel` on the host, keeps it alive, and pipes Telegram messages in and replies back out over a Unix socket. Same UX, same subscription, no programmatic-credit drip.

## Architecture

```
┌────────────┐    ┌─────────────────┐    ┌──────────────────┐    ┌──────────┐
│  Telegram  │ ─▶ │  outpost-daemon │ ─▶ │ outpost-channel  │ ─▶ │  claude  │
│   (you)    │ ◀─ │  (this repo)    │ ◀─ │ (stdio MCP)      │ ◀─ │ (PTY'd)  │
└────────────┘    └─────────────────┘    └──────────────────┘    └──────────┘
                          │     ▲                  │     ▲
                          │     │  Unix socket     │     │
                          │     └──── NDJSON ──────┘     │
                          │                              │
                          └── supervises (PTY spawn) ────┘
```

Three pieces, one box:

- **outpost-daemon** — owns the Telegram bot, the Unix socket, and `claude`'s lifecycle. Restarts claude on crash with backoff.
- **outpost-channel** — a stdio MCP server that `claude` loads. Connects up to the daemon's Unix socket, forwards `inbound` events into claude as `<channel>` notifications, sends `reply` tool calls back out.
- **claude** — one long-running interactive session. Workspace, MCP, settings all pre-seeded by the daemon so it boots unattended.

Wire details in [`channel/protocol.md`](channel/protocol.md).

## Why not the [official Telegram plugin](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram)?

Different shape, different use case. Both run in the interactive subscription bucket post-2026-06-15, so billing isn't the axis any more.

| | **outpost** | **official plugin** |
|---|---|---|
| Where claude runs | Headless on a remote machine, 24/7 | Your local interactive session |
| Who hosts it | You (pm2 / systemd on a VM) | Claude Code itself |
| You at your desk | Optional — train, bed, meeting all fine | Required |
| Process supervision | Daemon-side: spawn / respawn / pre-seed startup dialogs | None — claude is the long-lived process |
| Markdown rendering | GFM tables flattened to text cards, fenced code blocks preserved through HTML escaping (`src/messages.ts`) | Whatever the plugin ships |
| Access control | Static `ALLOWED_USER_IDS` allow-list | Pairing flow + per-group / per-user policy |
| Setup cost | Higher (clone, build, daemon, login) | Lower (one `/plugin install`) |

Use **outpost** if you want an agent that exists when you don't.
Use the **official plugin** if claude is something you sit in front of and Telegram is a second screen.

> `/restart`, `/new`, `/clear`, `/switch` — not implemented yet. The supervisor already knows how to respawn; surfacing it as a Telegram command is on the list, not in the binary.

## Install — For Humans

Four things only. The agent does the rest.

1. **Get claude logged in on the host.** SSH into the VM and run `claude` interactively at least once — pick a theme, run `/login`, paste the code. outpost will not handle first-run auth for you.
2. **Install Bun** (the channel runtime): `curl -fsSL https://bun.sh/install | bash`. Node 20+ is also fine for the daemon, but the channel itself runs under Bun.
3. **Get a bot token** — DM [@BotFather](https://t.me/BotFather), `/newbot`, copy the token.
4. **Get your Telegram user ID** — DM [@userinfobot](https://t.me/userinfobot), it replies with a numeric ID.

Then either fill in `.env` and run the §For the Agent SOP yourself, or paste this into a claude session on the host:

> Install outpost from https://github.com/zyx1121/outpost on this machine. Follow the §For the Agent section of the README end-to-end.
> - TELEGRAM_BOT_TOKEN: `123456789:AAH...`
> - ALLOWED_USER_IDS: `412587349`
> - AGENT_NAME: `myagent`

When the agent reports back "outpost is up", open Telegram, find your bot, send `/start`.

## Install — For the Agent

You're reading this because a human asked you to install outpost. Execute end-to-end. Report when finished with the bot's @username and pm2 status.

**1. Verify prerequisites:**

```bash
which claude || { echo "install claude first"; exit 1; }
which bun    || { echo "install bun first";    exit 1; }
claude --version
```

**2. Clone, install, build:**

```bash
git clone https://github.com/zyx1121/outpost.git ~/outpost
cd ~/outpost
npm install
npm run build
mkdir -p logs
```

**3. Write `.env`** using the values from the human:

```bash
cat > .env <<EOF
TELEGRAM_BOT_TOKEN=<token>
ALLOWED_USER_IDS=<user_id>
AGENT_NAME=<name>
CLAUDE_BIN=$(command -v claude)
EOF
chmod 600 .env
```

**4. Seed the workspace's `CLAUDE.md`** — this is what the agent reads on every turn. Default workspace is `$HOME/outpost-data`.

```bash
WS="${CLAUDE_WORKSPACE:-$HOME/outpost-data}"
mkdir -p "$WS"
[ -f "$WS/CLAUDE.md" ] || cat > "$WS/CLAUDE.md" <<'EOF'
# Agent

Replace this with the agent's personality, responsibilities, and any project pointers.
Claude reads this on every turn — edits take effect immediately, no redeploy.
EOF
```

**5. Start under pm2:**

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup    # run the printed sudo command if pm2 emits one
pm2 list | grep outpost
pm2 logs outpost --lines 80 --nostream    # confirm `claude spawned` and `@<bot> ready`
```

**6. Report to the human:**
- pm2 status for the `outpost` process
- Bot @username (from the `[boot] @<name> ready.` line)
- Whether workspace `CLAUDE.md` was pre-existing or newly seeded
- Any auth issues (claude not logged in, socket permission, etc.)

## Environment

| Var | Required | Default | Purpose |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | — | Token from @BotFather |
| `ALLOWED_USER_IDS` | yes | — | Comma-separated Telegram user IDs allowed to talk |
| `AGENT_NAME` | no | `agent` | Display name in `/start` banner and boot logs |
| `CLAUDE_BIN` | no | `claude` | Path to the `claude` binary (prefer absolute) |
| `OUTPOST_SOCK` | no | `/run/outpost.sock`, falls back to `$HOME/outpost.sock` | Unix socket the channel connects to |
| `CLAUDE_WORKSPACE` | no | `$HOME/outpost-data` | Where the daemon seeds `.mcp.json`, `.claude/settings.local.json`, and where you place `CLAUDE.md` |
| `OUTPOST_PTY_LOG` | no | unset | If set, mirror claude's raw PTY output to stderr. Off by default — pm2 err.log stays readable |

`SESSIONS_FILE`, `IDLE_TIMEOUT`, `HARD_TIMEOUT` are gone — there's one long-running claude now; there's nothing to time out or persist.

## Telegram commands

| Command | What |
|---|---|
| `/start` | Boot banner |
| `/help` | Command reference |
| `/status` | Daemon uptime |

Plain text, photos, and documents (not starting with `/`) go to claude verbatim. Photos and documents are downloaded to `CLAUDE_WORKSPACE` first, then dispatched with the saved path appended to the caption.

That's the entire surface area today. No `/new`, no `/resume`, no `/cancel`. The session is whatever claude has been doing since boot.

## How sessions work

There is one claude. It started when the daemon started. Everything in its context window is whatever has happened since.

Routing key is the Telegram `chat_id`. Inbound messages arrive at claude tagged like:

```xml
<channel source="telegram" chat_id="tg:412587349" user="loki" ts="2026-05-14T10:32:00Z">
  where is the auth middleware?
</channel>
```

Claude calls the `reply` MCP tool with that same `chat_id` and the daemon sends the text back to the right Telegram chat.

No `--resume`, no multi-session, no per-chat cwd. If you want a fresh context, `pm2 restart outpost` — that's the v0 reset button. Smarter session management is a v1 problem.

## Intentionally not bundled

- **`/new`, `/clear`, `/switch`** — one claude, one workspace, no session selector. Coming back when there's a real story for multi-session under one supervisor.
- **Streaming partial replies** — the `reply` MCP tool is atomic by design ([protocol.md → Out of scope](channel/protocol.md#out-of-scope)). Claude replies once per turn, not incrementally. Faking it with multiple `reply` calls is on the "no" list.
- **Permission relay** — Bash / Write approvals can't come from Telegram yet. Workaround: the supervisor pre-allowlists `Read`/`Write`/`Edit`/`Bash`/etc. in `.claude/settings.local.json`, so claude doesn't block on approval prompts at all. Not bypass mode — granular allow.
- **Discord / iMessage bridges** — outpost is Telegram-only. The channel protocol could host other transports; nobody's written them.
- **Inbound persistence** — if the daemon is down when Telegram delivers a message, the message is lost. The daemon is supposed to be the most stable thing in the box; if it isn't, fix the daemon instead of adding a queue.

## Implementation notes

**PTY is required.** Claude detects non-TTY stdin/stdout and falls into `-p` (programmatic) mode — which is exactly what we're avoiding. `node-pty` gives it a real TTY.

**Startup dialog seeding.** A fresh `claude` boot wants the human to dismiss five things before it'll talk: theme picker, login, folder-trust dialog, MCP discovery dialog, and (for the development-channels flag) a "this is experimental" warning. `supervisor.ts` handles each:

- Theme + login — must be done once by a human via interactive `claude` on the host.
- Folder trust + MCP discovery — pre-set in `~/.claude.json` under `projects[<workspace>]`.
- Dev-channels warning — detected in PTY output, dismissed by writing `\r` (cursor sits on "local development" by default).

If `claude` ever changes any of these prompts, the supervisor will hang on boot. That's the cost of bypassing the dialogs without a CLI flag for it.

**Markdown → Telegram HTML.** Telegram's `parse_mode: "HTML"` is a small subset — no `<table>`, no nested formatting in many spots. `src/messages.ts` extracts fenced code blocks into placeholders, runs the markdown transforms (inline bold/italic/links, headings, GFM tables flattened into text "cards"), then restores code blocks last. On HTML send failure, falls back to plain text by stripping tags.

**pm2 fork mode.** Cluster mode would race two Telegram pollers on `getUpdates` and hit a 409 that silently kills update fetching. Fork = single process, hard restart on reload.

**Bun on PATH.** pm2 launched via systemd doesn't inherit interactive shell PATH. `ecosystem.config.cjs` splices `~/.bun/bin` and `~/.local/bin` to the front so the channel can spawn.

## License

[MIT](LICENSE.md) — take it, fork it, write whatever soul you want into `CLAUDE.md`.
