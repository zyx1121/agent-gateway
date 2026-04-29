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

A Telegram ↔ Claude Code agent gateway. Stuffs the entirety of Claude Code (filesystem, shell, MCP, skills, subagents) into a Telegram chat — wearing the persona of your choice.

Ships with **Raphael** (智慧之王・拉斐爾, from *Tensura*) as the default persona. Want a different character? Drop a new module in `src/personas/` and point `PERSONA=` at it.

## Architecture

```
┌────────────┐         ┌────────────────┐         ┌──────────────┐
│  Telegram  │ ──────▶ │ agent-gateway  │ ──────▶ │  claude -p   │
│   (you)    │ ◀────── │  (this repo)   │ ◀────── │  per session │
└────────────┘         └────────────────┘         └──────────────┘
                              │
                              ├─ grammy (Telegram bot framework)
                              ├─ stream-json parser
                              ├─ markdown → Telegram HTML
                              ├─ session manager (file-based)
                              ├─ persona dispatch (system prompt + UX layer)
                              └─ pm2 daemon
```

Three layers:

- **core** — bot loop, session manager, claude spawner, stream parser. Persona-agnostic.
- **persona** — system prompt + Telegram UX (banners, tags, tool-call narration). Swappable per deploy via `PERSONA=`.
- **skills** — optional capability bundles you can mount into a persona (PVE control, etc). Wired in upcoming releases.

Each Telegram session maps to a Claude Code session id. Every turn spawns one `claude -p --resume <id>`; stream-json events get parsed and forwarded to Telegram in real time — tool calls, text deltas, usage stats.

## Tech Stack

- **Runtime**: Node.js 20+ with TypeScript
- **Framework**: [grammY](https://grammy.dev) (Telegram bot)
- **Backend**: Claude Code CLI (`claude -p`)
- **Process manager**: pm2
- **Package manager**: npm

## Commands

| Command | What |
|---|---|
| `/start` | Boot banner |
| `/help` | Command reference |
| `/new <name> [--in <path>] [--desc <text>]` | Create a new agent session. `--in` to mount an existing dir as cwd; `--desc` to inject role context |
| `/list` | All sessions (▶ = active), with turn count and last-active timestamp |
| `/resume [sid8]` | Wake up a parked session. No arg → inline keyboard picker |
| `/clear` | Park the active session (non-destructive; resumable) |
| `/delete [sid8]` | Permanently delete. No arg → picker |
| `/cancel` | Interrupt the running turn |
| `/status` | Bot state + active session info |
| `/mcp` | Registered MCP servers + auth status |
| `/skills` | Available Claude Code skills |
| `/usage` | Subscription usage bars (current session / week all / week Sonnet) |

Attachments: drop a photo or file into the chat — gets downloaded to the active session's cwd, and the persona is told the path.

## Getting Started

### Prerequisites

- Node.js 20+
- `claude` CLI installed and runnable (`curl -fsSL https://claude.ai/install.sh | bash`)
- `expect` for `/usage` (`apt install expect`)
- A 24/7 host to run the bot (pm2 / systemd recommended)

### 1. Register the bot

1. Talk to [@BotFather](https://t.me/BotFather), `/newbot`, grab the token
2. Talk to [@userinfobot](https://t.me/userinfobot) to get your numeric Telegram user id

### 2. Install + configure

```bash
git clone https://github.com/zyx1121/agent-gateway.git ~/agent-gateway
cd ~/agent-gateway
npm install
cp .env.example .env
# Edit .env: TELEGRAM_BOT_TOKEN, ALLOWED_USER_IDS, PERSONA
mkdir -p logs ~/agents
npm run build
```

### 3. Run

```bash
# Dev mode (hot reload)
npm run dev

# Production (pm2)
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup  # follow the printed command for boot persistence
```

Open your bot in Telegram and `/start` — you should see the boot banner.

## Environment Variables

| Var | Required | Default | Purpose |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | ✓ | — | Token from @BotFather |
| `ALLOWED_USER_IDS` | ✓ | — | Comma-separated Telegram user ids allowed to talk; everyone else is rejected |
| `PERSONA` | | `raphael` | Which persona module under `src/personas/` to load |
| `CLAUDE_BIN` | | `claude` | Full path to the `claude` binary (use absolute path to avoid PATH headaches) |
| `AGENT_HOME` | | `$HOME/agents` | Root dir for per-session working directories |
| `SESSIONS_FILE` | | `./sessions.json` | Where session metadata is persisted |

## File Layout

```
src/
├── index.ts              Bot entry: commands, attachment handling, turn loop
├── config.ts             env loader, allow-list parser, persona selector
├── session.ts            Per-user session manager (in-memory + file persist)
├── claude.ts             claude -p spawning, stream-json parsing, probe helpers
├── runner.ts             Turn loop (one prompt → stream events → Telegram)
└── personas/
    ├── index.ts          Runtime persona dispatch
    └── raphael.ts        Default persona (system prompt + UX rendering)
```

## Personas

A persona is a TypeScript module under `src/personas/` exporting:

- `id` — short identifier (matches `PERSONA=`)
- `displayName` — human-readable (used in boot logs, banners)
- `systemPrompt` — appended to every `claude -p` turn
- All the UX rendering functions consumed by `index.ts` and `runner.ts` (tags, banners, help text, tool-call narration, error messages, mcp/skills/usage formatters, markdown→HTML, message splitter)

To add a new persona:

1. Copy `src/personas/raphael.ts` → `src/personas/<name>.ts`
2. Customize `id`, `displayName`, `systemPrompt`, and any UX text you want different
3. Register it in `src/personas/index.ts`
4. Set `PERSONA=<name>` in `.env`

The bundled **raphael** persona: calm, confident, occasionally dryly amused. Sprinkles two-character prefixes (`報告。` / `回答。` / `建議。` / `警告。` / `告知。` / `詢問。`) — but not every line. No emoji. No "hope this helps".

## Implementation Notes

A trail of breadcrumbs through the landmines, so future-you doesn't step on them again.

### Streaming

Uses `--include-partial-messages` and parses `stream_event` blocks (`content_block_start` / `_delta` / `_stop`).

- Each text block opens its own Telegram message, **eagerly** at `content_block_start` (do *not* defer to first delta — see race below)
- Deltas append to a buffer; throttled to ~500ms between `editMessageText` calls
- During streaming we only HTML-escape (markdown rendering on a half-formed `<b>` would explode); the final stop runs the full markdown→HTML pipeline
- Once a block stops, no more edits to that message

> **The race we hit**: lazy creation (only sending the placeholder when the first delta arrived) caused multiple in-flight `flushSeg` calls — all seeing `msgId === null` during the awaited `ctx.reply` — to each send their own placeholder. Result: duplicate messages on screen. Eager create fixed it.

### Markdown rendering

Telegram doesn't render native markdown, so we transform on the gateway side:

- ` ``` ``` ` fenced code → `<pre><code>`
- `` `inline` `` → `<code>`
- `**bold**` → `<b>`
- `_italic_` → `<i>`
- `# / ## / ### headings` → `<b>`
- `[text](url)` → `<a href>`
- `---` → unicode horizontal rule

Order matters: extract code blocks first into placeholders so their contents don't get re-parsed as markdown, run inline transforms on the rest, then restore.

### MCP OAuth limitation

The gateway spawns one `claude -p` per turn. Each spawn is a fresh process. MCP server PKCE OAuth requires the authorize-and-callback round trip to live in a single process (the `code_verifier` only lives in memory) — so **you can't complete first-time MCP OAuth from inside Telegram**.

Workaround: do the OAuth once on the server using the native `claude` TUI; tokens land in `~/.claude/` and every subsequent `claude -p` spawn picks them up.

```bash
# From your local machine: open a SOCKS tunnel so your browser
# can reach the server's localhost
ssh -D 1080 user@server
# Configure your browser to use SOCKS5 → localhost:1080
# In another terminal:
ssh -t user@server claude
# Inside the TUI: /mcp → pick the server → walk through OAuth
```

Long-term plan: a PTY-based dual-rail mode — interactive (login / `claude mcp add`) drives a persistent claude REPL via `node-pty`, production turns stay on `-p`. Coming in a future release.

### `/usage` is scraped from the TUI

`claude -p "/usage"` only returns a placeholder string — the real usage figures are fetched and rendered as ANSI bars by the TUI itself. So `/usage` here drives the native TUI through `expect`, sends `/usage`, captures the rendered output, and parses the three bars. Each call takes ~8–10 seconds. Not cheap, but it's the only way to get the real numbers.

### Per-session lock

To prevent two messages on the same session from spawning two concurrent `claude -p --resume <same-id>` (which would corrupt session state), each session has an in-memory `AbortController` while busy. `/cancel` aborts via that controller (SIGTERM, then SIGKILL after 3s).

### System prompt injection

Every turn appends `--append-system-prompt <persona.systemPrompt>` (defined per-persona under `src/personas/`). If the session was created with `--desc`, that text is appended to the persona prompt as additional session context.

## Deploy notes

- pm2 in cluster mode (single instance); restart auto-restores sessions from `sessions.json`
- If you're on a PVE/VM setup, install `iptables-persistent` so port-forwarding rules survive reboot
- `chmod 600 .env`

## License

[MIT](LICENSE.md) — take it, fork it, just don't pretend to be someone else's Wisdom King.
