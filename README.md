```
██████╗  █████╗ ██████╗ ██╗  ██╗ █████╗ ███████╗██╗
██╔══██╗██╔══██╗██╔══██╗██║  ██║██╔══██╗██╔════╝██║
██████╔╝███████║██████╔╝███████║███████║█████╗  ██║
██╔══██╗██╔══██║██╔═══╝ ██╔══██║██╔══██║██╔══╝  ██║
██║  ██║██║  ██║██║     ██║  ██║██║  ██║███████╗███████╗
╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚══════╝
```

# Raphael

Telegram ↔ Claude Code 的 agent gateway。把整個 Claude Code 的能力（檔案、shell、MCP、skills、subagents）以智慧之王・拉斐爾的人格塞進 Telegram 對話框。

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
                              └─ pm2 daemon
```

每個 Telegram session 對應一個 Claude Code session id。一個 turn 一次 `claude -p --resume <id>`，stream-json 即時串流 tool calls / 文字 / usage 回 Telegram。

## Tech Stack

- **Runtime**: Node.js 20+ + TypeScript
- **Framework**: [grammY](https://grammy.dev) (Telegram bot)
- **Backend**: Claude Code CLI (`claude -p`)
- **Process manager**: pm2
- **Package manager**: npm

## Commands

| Command | What |
|---|---|
| `/start` | 啟動畫面 |
| `/help` | 指令一覽 |
| `/new <name> [--in <path>] [--desc <text>]` | 創設新個體；`--in` 指定既存目錄當 cwd，`--desc` 注入角色描述 |
| `/list` | 所有個體（▶ = active）+ 最後活動時間 + turn 數 |
| `/use <sid8>` | 切換 active |
| `/resume [sid8]` | 喚回；無參數跳出 inline keyboard |
| `/clear` | 停泊當前個體（不刪、可 `/resume` 喚回） |
| `/delete [sid8]` | 徹底抹消；無參數跳出選單 |
| `/cancel` | 中斷進行中的演算 |
| `/status` | bot 狀態 + 當前 session |
| `/mcp` | MCP server 一覽 + 認證狀態 |
| `/skills` | 可用 skills |
| `/usage` | Claude Code 訂閱用量（current session / week all / week Sonnet） |

附件：直接傳圖片或檔案會自動下載到當前 session cwd 並通知 Raphael 路徑。

## Getting Started

### Prerequisites

- Node.js 20+
- `claude` CLI 已安裝且能跑 (`curl -fsSL https://claude.ai/install.sh | bash`)
- `expect` 可選，`/usage` 指令需要 (`apt install expect`)
- 一台 24/7 伺服器跑 bot（推薦 systemd / pm2 守護）

### 1. Telegram bot 註冊

1. 在 Telegram 找 [@BotFather](https://t.me/BotFather)，`/newbot` 拿 token
2. 在 [@userinfobot](https://t.me/userinfobot) 拿你的 user_id

### 2. 安裝 + 設定

```bash
git clone https://github.com/zyx1121/raphael.git ~/agent-gateway
cd ~/agent-gateway
npm install
cp .env.example .env
# 編輯 .env，填 TELEGRAM_BOT_TOKEN 與 ALLOWED_USER_IDS
mkdir -p logs ~/agents
npm run build
```

### 3. 啟動

```bash
# 開發模式（hot reload）
npm run dev

# 正式（pm2 守護）
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup  # 跟著它印的指令做完開機自啟
```

去 Telegram 找你的 bot 按 `/start`，看到 boot 動畫就成功。

## Environment Variables

| Var | Required | Default | Purpose |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | ✓ | — | BotFather 給的 token |
| `ALLOWED_USER_IDS` | ✓ | — | 逗號分隔的 Telegram user_id 白名單；其他人會被拒 |
| `CLAUDE_BIN` | | `claude` | claude binary 完整路徑（建議寫絕對路徑避免 PATH 議題） |
| `AGENT_HOME` | | `$HOME/agents` | 每個 session 的工作目錄根 |
| `SESSIONS_FILE` | | `./sessions.json` | session metadata 持久化檔 |

## File Layout

```
src/
├── index.ts        Bot 主入口、commands、attachment、turn 流程
├── config.ts       env loader，白名單 parse
├── session.ts      per-user session 管理 (in-memory + file persist)
├── claude.ts       claude -p spawn、stream-json parser、probe helpers
└── raphael.ts      訊息排版層（MarkdownV2/HTML、拉斐爾 flavor）
```

## Implementation Notes

把走過的雷留下來，下次回來才不會重踩。

### Streaming

用 `--include-partial-messages` + `stream_event` 解 `content_block_start/delta/stop`。

- 每個 text block 在 Telegram 開一條訊息（**eager**，於 `content_block_start` 立刻 send）
- deltas 累進到 buffer，throttle ~500ms 一次 `editMessageText`
- 串流中只做 HTML escape（避免半截 markdown 失敗），最終 stop 才套 markdown→HTML 完整渲染
- block 結束後不再 edit

> 早期 lazy create（在第一個 delta 才 send placeholder）會踩 race：throttle 期間多個 flushSeg 同時看到 msgId === null 各送一條，產生重複訊息。eager create 解決。

### Markdown rendering

Telegram 不認原生 markdown，gateway 做轉換：

- ` ``` ``` ` 程式碼塊 → `<pre><code>`
- `` `inline` `` → `<code>`
- `**bold**` → `<b>`
- `_italic_` → `<i>`
- `# / ## / ### heading` → `<b>` 粗體
- `[text](url)` → `<a href>`
- `---` → unicode 分隔線

順序很重要：先抽出 code block 用 placeholder 替代，避免內容被當作 markdown 二次解析；其他 inline 規則處理完再復原。

### MCP OAuth limitation

Gateway 一 turn 一個 `claude -p`，每次 spawn 都是新 process。MCP server 的 PKCE OAuth 流程要求發 code 跟收 callback 在同一進程（code_verifier 只活在記憶體）→ 因此**沒辦法在 Telegram 內完成首次 OAuth**。

繞過方式：在 server 上跑一次原生 `claude` TUI，`/mcp` 選 server，瀏覽器走完授權；token 寫進 `~/.claude/`，之後 bot spawn 的 `claude -p` 都讀得到。

```bash
# 從本機建 SOCKS 隧道（讓本機瀏覽器能打到 server localhost）
ssh -D 1080 user@server
# 瀏覽器設 SOCKS5 → localhost:1080
# 另開 ssh：
ssh -t user@server claude
# TUI 裡 /mcp，選 server，跟著 OAuth 走完
```

長期解：改用 `@anthropic-ai/claude-agent-sdk` 跑常駐 process per session（沒做）。

### `/usage` 是 TUI 抓的

`claude -p "/usage"` 只回 placeholder text，真實 usage 數字是 TUI 內部 fetch + 渲染 ANSI bars。所以 `/usage` 在這 gateway 是用 `expect` 跑原生 claude TUI，送 `/usage`，攔 ANSI 輸出 parse 三條 bar。每次 ~8-10 秒，不是 cheap，但能拿到對的數值。

### Per-session lock

避免同 session 連送兩條訊息同時 spawn 兩個 `claude -p --resume <same-id>` 衝突，用 `AbortController` 加 in-memory busy map。`/cancel` 透過 controller 殺掉子程序（SIGTERM → 3s → SIGKILL）。

### 系統 prompt 注入

每個 turn 都 `--append-system-prompt <SYSTEM_PROMPT_BASE>`，內容在 `src/claude.ts`。如果 `--desc` 有設，會附加到 base prompt 後面。

## Deploy notes

- pm2 用 cluster mode（單 instance），重啟自動恢復 sessions（從 `sessions.json` 讀）
- `iptables-persistent` 在 host 重開後自動 restore port forwarding 規則（如果你用 PVE/VM）
- `.env` 設 `chmod 600`

## Persona

智慧之王・拉斐爾。冷靜、自信、會冷吐槽。語氣前綴點綴（報告。回答。建議。警告。告知。詢問。）但不每句都用。沒有 emoji，沒有「希望這對你有幫助」。

## License

[MIT](LICENSE.md) — 拿去玩、別拿去當別人的智慧之王。
