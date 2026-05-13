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

A Telegram client to a headless Claude Code agent. Each chat is one Claude session, with its own cwd and history. Drop in, drop out, pick back up days later — the agent's been waiting.

## Why not the [official Telegram plugin](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram)?

Different shape, different use case. Pick whichever matches your reality.

| | **outpost** | **official plugin** |
|---|---|---|
| Where Claude Code runs | Headless daemon on a remote machine, 24/7 | Your local interactive session |
| Who hosts it | You (pm2 / systemd on a VM) | Claude Code itself |
| Sessions | Multi — each Telegram chat = independent Claude session with own cwd | Single — Telegram is another input into your current session |
| You at your desk | Optional. Can be on a train, in bed, in a meeting | Required |
| Setup | Higher (clone, build, daemon, login) | Lower (one `/plugin install`) |
| Access control | Static allow-list | Pairing flow + per-group / per-user policy |

Use **outpost** if you want an agent that exists when you don't.
Use the **official plugin** if Claude Code is something you sit in front of and Telegram is just a second screen.

## Architecture

```
┌────────────┐         ┌────────────────┐         ┌──────────────┐
│  Telegram  │ ──────▶ │    outpost     │ ──────▶ │  claude -p   │
│   (you)    │ ◀────── │   (this repo)  │ ◀────── │  per session │
└────────────┘         └────────────────┘         └──────────────┘
                              │                         │
                              ├─ grammy bot loop        └─ reads ~/CLAUDE.md
                              ├─ session manager           (the agent's soul)
                              ├─ stream-json parser
                              ├─ markdown → Telegram HTML
                              └─ pm2 daemon
```

Two layers:

- **outpost** — pure glue. Telegram in, `claude -p` out, stream-json events forwarded back as edits. No personality.
- **soul** — `~/CLAUDE.md` on the host. Defines who the agent is. Owned by Claude Code's native CLAUDE.md mechanism.

Each Telegram chat maps to a Claude Code session id. Every turn spawns one `claude -p --resume <id>` with `cwd=$HOME` (so `~/CLAUDE.md` auto-loads); stream-json events get parsed and forwarded to Telegram in real time.

## Install

### For Humans (≈ 5 minutes)

You only do four things. The agent does the rest.

1. **Get a bot token** — DM [@BotFather](https://t.me/BotFather), `/newbot`, follow prompts, copy the token (looks like `123456789:AAH...`).
2. **Get your Telegram user ID** — DM [@userinfobot](https://t.me/userinfobot), it replies with a numeric ID.
3. **SSH into the host** that will run the outpost. Anywhere with Node 20+ and a 24/7 power cord works (VM, Raspberry Pi, home server).
4. **Tell the agent on that host to install it.** Paste this, with your values substituted:

   > Install outpost from https://github.com/zyx1121/outpost on this machine. Follow the §For the Agent section of the README end-to-end.
   > - TELEGRAM_BOT_TOKEN: `123456789:AAH...`
   > - my Telegram user ID: `412587349`
   > - AGENT_NAME: `myagent` (or whatever you want shown in the boot banner)

When the agent reports back "outpost is up", open Telegram, find your bot, send `/start`. You're in.

### For the Agent

You are reading this because a human asked you to install outpost on this machine. Execute the steps below end-to-end. Report back only when finished, with the bot's @username and pm2 status.

**1. Verify prerequisites:**

```bash
node --version            # need 20+
which claude || curl -fsSL https://claude.ai/install.sh | bash
command -v expect || echo "expect missing — install with the host's package manager if /login is needed"
```

**2. Clone, install, build:**

```bash
git clone https://github.com/zyx1121/outpost.git ~/outpost
cd ~/outpost
npm install
npm run build
mkdir -p logs
```

**3. Write `.env`** using the values the human gave you:

```bash
cat > .env <<EOF
TELEGRAM_BOT_TOKEN=<token>
ALLOWED_USER_IDS=<user_id>
AGENT_NAME=<name>
CLAUDE_BIN=$(command -v claude)
SESSIONS_FILE=$HOME/outpost/sessions.json
EOF
chmod 600 .env
```

**4. Seed `~/CLAUDE.md` if missing** — this is the agent's soul. Don't overwrite an existing one.

```bash
[ -f ~/CLAUDE.md ] || cat > ~/CLAUDE.md <<'EOF'
# Agent

Replace this with the agent's personality, responsibilities, and any project pointers.
Claude Code reads this file on every turn — edits take effect immediately, no redeploy.
EOF
```

**5. Confirm `claude` is logged in:**

```bash
claude -p "say ok" --output-format json
```

If this fails with an auth error, note it in your final report — the human will need to send `/login` from Telegram after the bot starts.

**6. Start under pm2:**

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup    # follow the printed command if pm2 asks
pm2 logs outpost --lines 50 --nostream    # confirm Telegram polling started without 409
```

**7. Report to the human:**
- pm2 process name and status (`pm2 list | grep outpost`)
- The bot's @username (from the boot banner in pm2 logs)
- Whether `~/CLAUDE.md` was pre-existing or newly seeded
- Any prerequisite or auth issues that need human action

## Commands

| Command | What |
|---|---|
| `/start` | Boot banner |
| `/help` | Command reference |
| `/new <name> [--in <path>]` | Create a session. Default cwd `$HOME` (so `~/CLAUDE.md` drives it). `--in` mounts a project dir instead |
| `/list` | All sessions (`*` = active), turn count, last-active timestamp |
| `/resume [sid8]` | Wake up a parked session. No arg → inline keyboard picker |
| `/clear` | Park the active session (non-destructive; resumable) |
| `/delete [sid8\|all]` | Permanently delete one or all. No arg → picker |
| `/cancel` | Interrupt the running turn |
| `/status` | Bot state + active session info |
| `/login` | PTY-bridged Claude OAuth flow (URL forwarded to chat, paste the code back) |

Attachments: drop a photo or file — gets downloaded to the active session's cwd, agent is told the path.

### What outpost intentionally does **not** bundle

Anything the agent can do for you doesn't need to be a slash command. Just ask the session.

| Want | Just ask Claude |
|---|---|
| Usage / quota | "how's my usage looking?" |
| List MCP servers / skills | "what MCPs are loaded? what skills do you have?" |
| Self-update | "git pull, rebuild, and `pm2 reload outpost`" |
| Inspect logs | "show me the last 50 lines of pm2 logs" |

Older versions shipped `/usage`, `/update`, `/trace`, `/mcp`, `/skills` as built-in slash commands. They've been removed — the agent is more capable than any slash command we'd write.

## Environment Variables

| Var | Required | Default | Purpose |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | ✓ | — | Token from @BotFather |
| `ALLOWED_USER_IDS` | ✓ | — | Comma-separated Telegram user IDs allowed to talk; everyone else gets denied |
| `AGENT_NAME` | | `agent` | Display name for this instance (shown in `/start` banner and boot logs). Personality itself lives in `~/CLAUDE.md` |
| `CLAUDE_BIN` | | `claude` | Path to the `claude` binary (prefer absolute to avoid PATH headaches) |
| `SESSIONS_FILE` | | `$HOME/outpost/sessions.json` | Where session metadata is persisted |
| `IDLE_TIMEOUT` | | `5m` | Kill the turn if Claude emits no stdout for this long. Accepts `30s` / `5m` / `1h` / plain ms |
| `HARD_TIMEOUT` | | `30m` | Wall-clock circuit breaker against runaway loops |

## Persona

outpost has zero opinions about personality. The agent's behavior comes entirely from `~/CLAUDE.md` (or whatever cwd you point a session at via `--in`). This is Claude Code's native mechanism — outpost just sets `cwd=$HOME` and lets Claude Code own the system prompt.

Why this design:

- **Single source of truth** — outpost and Claude Code never disagree about who the agent is
- **No redeploy to change personality** — `ssh` in, edit one markdown file, next turn picks it up
- **Multi-agent fleet from one repo** — three VMs running outpost, three different `~/CLAUDE.md`, three different personalities

For a project-scoped agent (one that lives inside a specific codebase), use `/new mycoder --in ~/some-project` — Claude Code will read that project's `CLAUDE.md` instead of `~/CLAUDE.md`.

## Notes

A few things worth knowing if you're poking the internals.

**Streaming.** Uses `--include-partial-messages` and parses `stream_event` blocks. Each text block opens its own Telegram message eagerly at `content_block_start` (lazy creation races itself when multiple deltas arrive concurrently — each in-flight call sees `msgId === null` during the awaited `ctx.reply` and sends a duplicate placeholder). Deltas are throttled to ~500ms between `editMessageText` calls. Final stop runs the markdown→HTML pipeline; during streaming we only HTML-escape (running markdown on a half-formed `<b>` explodes).

**Markdown → Telegram HTML.** Telegram doesn't render markdown. We extract fenced code blocks into placeholders first (so their contents don't get re-parsed as markdown), run inline transforms (`**bold**`, `_italic_`, `[text](url)`, headings, GFM tables flattened to "cards" since Telegram has no `<table>`), then restore.

**`/login` via PTY.** The `claude` REPL reads the OAuth URL prompt and authorization code interactively, neither of which `claude -p` exposes. So `node-pty` spawns `claude` with wide cols (2000) to prevent URL soft-wrap; whitespace-normalizes the buffer before regex matching (cursor positioning eats spaces in the visible buffer); auto-Enters theme/method pickers; matches the URL against a host whitelist (`claude.com` / `claude.ai` / `anthropic.com`). The handler is fire-and-forget — awaiting it would deadlock the chat (grammY dispatches per-chat sequentially, and the OAuth code message would never get processed).

**Per-session lock.** Each session has an in-memory `AbortController` while busy, preventing two messages from spawning concurrent `claude -p --resume <same-id>` calls (which would corrupt session state). `/cancel` aborts via that controller (SIGTERM, then SIGKILL after 3s).

**`--append-system-prompt` for sandbox plumbing only.** outpost injects a tiny tool-layer instruction telling Claude to set `dangerouslyDisableSandbox: true` on Bash calls. The Telegram bridge has no approval UI, and the Bash sandbox blocks writes outside cwd (e.g. `~/.claude/skills/`), which is the dominant failure mode here. Persona still lives entirely in `~/CLAUDE.md` — this is gateway-owned plumbing, not personality.

**pm2 fork mode.** Cluster mode races two Telegram pollers on `getUpdates`, hits 409, and silently kills update fetching. Fork = hard restart on reload, but reliable.

## Deploy notes

- `chmod 600 .env` — token is a credential
- pm2 restart auto-restores sessions from `sessions.json`
- On a PVE/VM setup, install `iptables-persistent` so port-forwarding rules survive reboot

## License

[MIT](LICENSE.md) — take it, fork it, write whatever soul you want into `~/CLAUDE.md`.
