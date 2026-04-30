```
 █████╗  ██████╗ ███████╗███╗   ██╗████████╗     ██████╗  █████╗ ████████╗
██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝    ██╔════╝ ██╔══██╗╚══██╔══╝
███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║       ██║  ███╗███████║   ██║
██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║       ██║   ██║██╔══██║   ██║
██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║       ╚██████╔╝██║  ██║   ██║
╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝        ╚═════╝ ╚═╝  ╚═╝   ╚═╝

███████╗██╗    ██╗ █████╗ ██╗   ██╗
██╔════╝██║    ██║██╔══██╗╚██╗ ██╔╝
█████╗  ██║ █╗ ██║███████║ ╚████╔╝
██╔══╝  ██║███╗██║██╔══██║  ╚██╔╝
███████╗╚███╔███╔╝██║  ██║   ██║
╚══════╝ ╚══╝╚══╝ ╚═╝  ╚═╝   ╚═╝
```

# agent-gateway

Telegram ↔ Claude Code gateway. Stuffs the entirety of Claude Code (filesystem, shell, MCP, skills, subagents) into a Telegram chat, with retro-terminal framing.

The gateway itself is **persona-agnostic** — every instance reads `AGENT_NAME` for its display banner, but the agent's actual personality lives in `~/CLAUDE.md` on each host. Claude Code reads it natively from the session cwd. Want a different agent? Edit one markdown file, no redeploy.

## Architecture

```
┌────────────┐         ┌────────────────┐         ┌──────────────┐
│  Telegram  │ ──────▶ │ agent-gateway  │ ──────▶ │  claude -p   │
│   (you)    │ ◀────── │  (this repo)   │ ◀────── │  per session │
└────────────┘         └────────────────┘         └──────────────┘
                              │                         │
                              ├─ grammy bot loop        └─ reads ~/CLAUDE.md
                              ├─ session manager           (the agent's soul)
                              ├─ stream-json parser
                              ├─ markdown → Telegram HTML
                              ├─ retro framework messages
                              └─ pm2 daemon
```

Two clean layers:

- **gateway** — pure glue. Telegram in, `claude -p` out, stream-json events forwarded back as edits. Speaks plain English with retro markers (`>>` for actions, `!!` for warnings). No personality.
- **soul** — `~/CLAUDE.md` on each host. Defines who the agent is, what it does, what tools it has. Owned by Claude Code's native CLAUDE.md mechanism — gateway never injects system prompts.

Each Telegram session maps to a Claude Code session id. Every turn spawns one `claude -p --resume <id>` with `cwd=$HOME` (so `~/CLAUDE.md` auto-loads); stream-json events get parsed and forwarded to Telegram in real time — tool calls, text deltas, usage stats.

## Tech Stack

- **Runtime**: Node.js 20+ with TypeScript
- **Framework**: [grammY](https://grammy.dev) (Telegram bot)
- **Backend**: Claude Code CLI (`claude -p`)
- **PTY bridge**: `node-pty` (for `/login` OAuth)
- **Process manager**: pm2 (fork mode)
- **Package manager**: npm

## Commands

| Command | What |
|---|---|
| `/start` | Boot banner |
| `/help` | Command reference |
| `/new <name> [--in <path>]` | Create a session. Default cwd `$HOME` so `~/CLAUDE.md` drives the agent. `--in` mounts a project dir instead |
| `/list` | All sessions (`*` = active), turn count, last-active timestamp |
| `/resume [sid8]` | Wake up a parked session. No arg → inline keyboard picker |
| `/clear` | Park the active session (non-destructive; resumable) |
| `/delete [sid8\|all]` | Permanently delete one or all. No arg → picker |
| `/cancel` | Interrupt the running turn |
| `/status` | Bot state + active session info |
| `/mcp` | Registered MCP servers + auth status |
| `/skills` | Available Claude Code skills |
| `/usage` | Subscription usage bars (current session / week all / week Sonnet) |
| `/update <gateway\|claude>` | git-pull + rebuild gateway, or `claude update` |
| `/login` | PTY-bridged Claude OAuth flow (URL gets forwarded to chat, paste back the code) |
| `/trace [N]` | Last N turn-log events (default 10) |

Attachments: drop a photo or file — gets downloaded to the active session's cwd, and the agent is told the path.

## Getting Started

### Prerequisites

- Node.js 20+
- `claude` CLI installed and runnable (`curl -fsSL https://claude.ai/install.sh | bash`)
- `expect` for `/usage` (`apt install expect`)
- A 24/7 host to run the bot (pm2 / systemd recommended)

### 1. Register the bot

1. Talk to [@BotFather](https://t.me/BotFather), `/newbot`, grab the token
2. Talk to [@userinfobot](https://t.me/userinfobot) for your numeric Telegram user id

### 2. Install + configure

```bash
git clone https://github.com/zyx1121/agent-gateway.git ~/agent-gateway
cd ~/agent-gateway
npm install
cp .env.example .env
# Edit .env: TELEGRAM_BOT_TOKEN, ALLOWED_USER_IDS, AGENT_NAME
mkdir -p logs
npm run build
```

### 3. Write the agent's soul

Drop a `~/CLAUDE.md` describing who this agent is. Claude Code reads it on every turn.

```bash
cat > ~/CLAUDE.md <<'EOF'
# My Agent

## 人格
冷靜、簡潔、技術導向。預設用繁體中文回應。

## 職責
[describe what this agent does]

## 行動
[describe what tools / SOPs this agent uses]
EOF
```

You can split this into multiple files (`SOUL.md`, `PLAYBOOK.md`, etc.) and reference them via `@file.md` if it grows. Start with one file.

### 4. Run

```bash
# Dev mode (hot reload)
npm run dev

# Production (pm2)
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup  # follow the printed command for boot persistence
```

Open your bot in Telegram and `/start` — you should see `agent-gateway · <name> · ready.`

### 5. (Optional) `/login`

If `claude` is not yet logged in on this host, send `/login` from Telegram. The gateway drives a PTY-bridged OAuth flow: forwards the auth URL to chat, you complete it in browser, paste the code back, gateway submits it.

## Environment Variables

| Var | Required | Default | Purpose |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | ✓ | — | Token from @BotFather |
| `ALLOWED_USER_IDS` | ✓ | — | Comma-separated Telegram user ids allowed to talk; everyone else gets denied |
| `AGENT_NAME` | | `agent` | Display name for this instance (shown in `/start` banner and boot logs). The agent's actual personality lives in `~/CLAUDE.md` |
| `CLAUDE_BIN` | | `claude` | Full path to the `claude` binary (use absolute path to avoid PATH headaches) |
| `SESSIONS_FILE` | | `./sessions.json` | Where session metadata is persisted |

## File Layout

```
src/
├── index.ts       Bot entry: commands, attachment handling, /login glue
├── config.ts      env loader, allow-list parser
├── session.ts     Per-user session manager (in-memory + file persist)
├── claude.ts      claude -p spawning, stream-json parsing, probe helpers
├── runner.ts      Turn loop (one prompt → stream events → Telegram)
├── messages.ts    Framework messages + markdown → Telegram HTML
├── pty.ts         PTY bridge for the interactive /login OAuth flow
├── update.ts      git-pull + rebuild + pm2 reload
└── turnlog.ts     JSONL turn log (for /trace observability)
```

## Persona via `~/CLAUDE.md`

The gateway has **zero opinions about personality**. The agent's behavior comes entirely from `~/CLAUDE.md` (or whatever cwd you point a session at via `--in`). This is Claude Code's native mechanism — no system-prompt injection from the gateway.

Why this design:

- **Single source of truth** — gateway and Claude Code never disagree about who the agent is
- **No redeploy to change personality** — `ssh` in, edit one markdown file, next turn picks it up
- **Multi-agent fleet from one repo** — three VMs running this gateway, three different `~/CLAUDE.md`, three different personalities. Repo stays clean.

If you want a project-scoped agent (e.g. one that lives inside a specific codebase), use `/new mycoder --in ~/some-project` — Claude Code will read that project's `CLAUDE.md` instead of `~/CLAUDE.md`.

## Implementation Notes

A trail of breadcrumbs through the landmines.

### Streaming

Uses `--include-partial-messages` and parses `stream_event` blocks (`content_block_start` / `_delta` / `_stop`).

- Each text block opens its own Telegram message, **eagerly** at `content_block_start`
- Deltas append to a buffer; throttled to ~500ms between `editMessageText` calls
- During streaming we only HTML-escape (markdown rendering on a half-formed `<b>` would explode); the final stop runs the full markdown→HTML pipeline
- Once a block stops, no more edits to that message

> **The race we hit**: lazy creation (only sending the placeholder when the first delta arrived) caused multiple in-flight `flushSeg` calls — each seeing `msgId === null` during the awaited `ctx.reply` — to send their own placeholder. Result: duplicate messages on screen. Eager create + sync-set-then-async-fill-msgId fixed it.

### Markdown rendering

Telegram doesn't render native markdown, so we transform on the gateway side:

- ` ``` ``` ` fenced code → `<pre><code>`
- `` `inline` `` → `<code>`
- `**bold**` → `<b>`
- `_italic_` → `<i>`
- `# / ## / ### headings` → `<b>`
- `[text](url)` → `<a href>`
- `---` → unicode horizontal rule
- GFM tables → flattened "card" form (Telegram has no `<table>`, and its monospace doesn't align CJK to 2× latin)

Order matters: extract code blocks first into placeholders so their contents don't get re-parsed as markdown, run inline transforms on the rest, then restore.

### `/login` via PTY

The gateway can drive a Claude Code first-time OAuth login from Telegram. Why a PTY: the `claude` REPL reads the OAuth URL prompt and the authorization code interactively, neither of which `claude -p` exposes. So:

- `node-pty` spawns `claude` with wide cols (2000) so long OAuth URLs don't soft-wrap
- Buffer is whitespace-normalized before regex matching (cursor positioning eats spaces in the visible buffer)
- Theme picker / method picker get auto-Enter, the URL gets matched against the cumulative buffer (host whitelist: `claude.com` / `claude.ai` / `anthropic.com`)
- The `/login` handler is fire-and-forget — awaiting it would deadlock the chat (grammy dispatches per-chat sequentially, and the OAuth code message would never get processed)

### `/usage` is scraped from the TUI

`claude -p "/usage"` only returns a placeholder string — the real usage figures are fetched and rendered as ANSI bars by the TUI itself. So `/usage` here drives the native TUI through `expect`, captures the rendered output, and parses the three bars. ~8–10s per call; cached for 60s.

### Per-session lock

To prevent two messages on the same session from spawning two concurrent `claude -p --resume <same-id>` (which would corrupt session state), each session has an in-memory `AbortController` while busy. `/cancel` aborts via that controller (SIGTERM, then SIGKILL after 3s).

### Why no `--append-system-prompt`

Earlier versions injected a per-persona system prompt via `--append-system-prompt`. That double-stacked with Claude Code's native `~/CLAUDE.md` reading and caused drift between the two sources. Now the gateway just sets `cwd=$HOME` and lets Claude Code own the system prompt entirely.

### `/trace` observability

Every turn appends to `logs/turns.jsonl` (start / tool / answer / end / error). `/trace [N]` reads the last 64KB of that file and dumps the most recent N events to chat. Pure async fs/promises — non-blocking.

## Deploy notes

- pm2 in **fork mode** (single instance). Cluster mode caused two telegram pollers to race on `getUpdates`, hitting 409 and silently killing update fetching. Fork = hard restart on reload, but reliable.
- `restart auto-restores` sessions from `sessions.json`
- If you're on a PVE/VM setup, install `iptables-persistent` so port-forwarding rules survive reboot
- `chmod 600 .env`

## License

[MIT](LICENSE.md) — take it, fork it, write whatever soul you want into `~/CLAUDE.md`.
