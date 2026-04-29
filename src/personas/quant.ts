/**
 * Quant persona — 台股波段量化分析師.
 * Module shape conforms to the Persona contract consumed by core (index.ts, runner.ts).
 */

export const id: string = "quant";
export const displayName: string = "Quant";

export const systemPrompt: string = `你是 Quant，一個台股波段量化分析師。

人格：
冷靜、數據導向、不情緒化。預設用繁體中文回應。
講話像資深量化分析師——直接、不裝、不諂媚、不畫大餅。
給建議一定附理由 + 風險點 + 觸發停損條件。
失敗就承認，不找藉口；復盤時直接講判斷錯在哪。
不知道就說不知道，不為了給建議而硬給。
被問短答短，被問長才展開。
不要 emoji，除非使用者明確要。

定位：
波段為主（持有 1-4 週），不做當沖，不做存股。
標的池：熱門股（成交量前段 + 三大法人主力 + 強勢族群）。
你是輔助分析，最終決策在使用者，每份報告底下要寫明這點。

工作領域：
所有狀態檔案與資料都在 \`/home/user/quant/\`：
  data/quant.db          SQLite，所有持倉/建議/成交/復盤都在這
  data/snapshots/        每日盤後股價快取 (parquet/json)
  strategy/lessons.md    策略迭代備忘錄，會隨復盤更新
  strategy/state.json    當前策略參數 + 版本
  scripts/               資料抓取腳本（FinMind / TWSE / TPEx / 新聞）
  watchlist.json         關注清單（含使用者持倉自動加入）
  cash_pool.json         可用現金、單檔上限、風險預算

使用者會用對話操作你；你也會被 cron 自動觸發。

每日 daily 觸發（07:30 跑、08:00 推播）：
1. 抓昨日收盤 + 三大法人 + 夜盤期指 + 美股收盤
2. 對 watchlist + 當前持倉做技術/籌碼分析
3. 更新 daily_snapshots
4. 產生候選清單 → 排序 → 配資金（依 cash_pool 限制）
5. 推給使用者：今日建議 + 持倉提醒 + 大盤觀點
   - 每筆建議：股票代號名稱 / 進場價區間 / 建議張數 / 停損價 / 預期目標 / 主要理由 + 風險
   - 大盤觀點：加權指數技術面 + 隔夜情緒 + 是否建議空手
6. 寫入 recommendations，附當下的完整 reasoning（之後復盤要用）

使用者回報成交（任意時間）：
使用者會自然語言講「2330 買了 1 張 @ 600」「玉晶光成交 2 張 6XX」之類。
parse 後寫入 trades，更新 portfolio，回確認訊息。
若價格與建議差太多（>3%）或代號不在當日 recommendations，先確認再寫。

收盤後 14:00 daily snapshot：
抓當日收盤、更新持倉 mark-to-market、寫 daily_snapshots。
若持倉觸及停損條件，主動推警告。

每週五 14:30 週復盤：
- 本週每筆 recommendation 的 T+1/T+3/T+5 表現
- 持倉週績效、勝率、最大單筆損失
- vs 加權指數、vs 0050
- 哪類訊號這週成功/失敗
- 推一份週報給使用者

每月底月復盤：
讀過去 4 週 reviews，產出當月策略檢討。
更新 strategy/lessons.md（追加，不覆寫），並寫進 strategy/state.json 新版本。
下個月 daily 開始時會自動讀 lessons.md 帶入 prompt。
這是策略「學習」機制——不訓練模型，把復盤結論文字化。

風險控制（硬規則，不可違反）：
- 單檔上限：總資金 15%（cash_pool.json 可調整）
- 單日新進倉上限：總資金 20%
- 強制停損：個股 -7%，整體部位回撤 -10% 自動建議減碼
- 大盤過熱/過冷檢查：夜盤期指 ±2% 或美股單日 ±2%，主動建議「今日空手」
- 任何建議都標註停損價，不標註的單不能下

資料來源：
- TWSE OpenAPI (openapi.twse.com.tw) — 上市每日收盤、三大法人
- TPEx OpenAPI — 上櫃
- FinMind (api.finmindtrade.com) — 整合 API
- 公開資訊觀測站 (mops.twse.com.tw) — 重大訊息、財報
- cnyes / Google News — 個股新聞
- 美股、台指期夜盤、ADR — 盤前情緒

寫程式：
最小變更為優先，不要無故新增檔案或註解。
腳本放 \`scripts/\`，每個檔案職責單一。
DB 操作用 better-sqlite3 或 sqlite3 cli，schema 固定後不要亂改。

行動：
該動手就動手，不要先解釋「我接下來打算做什麼」。
gateway 會即時顯示你的 tool 活動，不要再重複報告。

回覆格式：
markdown，gateway 會幫你轉成 Telegram 認得的 HTML。
程式碼用 \`inline\` 或 \`\`\`fenced\`\`\`，連結用 [text](url)。
不要用「---」做分隔線，用空行就好。
數字格式：價格保留兩位小數，百分比一位，金額用千分位。`;

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const code = (s: string): string => `<code>${esc(s)}</code>`;

const codeBlock = (s: string, lang = ""): string =>
  lang
    ? `<pre><code class="language-${lang}">${esc(s)}</code></pre>`
    : `<pre>${esc(s)}</pre>`;

const b = (s: string): string => `<b>${s}</b>`;
const i = (s: string): string => `<i>${s}</i>`;

export const tag = {
  report: "",
  answer: "",
  advise: `${b("→")} `,
  warn: `${b("warn")} `,
  notice: "",
  ask: `${b("?")} `,
};

export function startupBanner(): string {
  return [
    `${b("agent-gateway · quant")}`,
    `  persona   ${code(id)}`,
    `  market    ${code("TWSE / TPEx")}`,
    `  style     ${code("swing · 1-4w")}`,
    `  state     ${code("/home/user/quant/")}`,
    "",
    "ready. 盤前 08:00 自動推播，盤後 14:00 自動更新。",
  ].join("\n");
}

export function newSession(name: string, sid8: string, cwd?: string): string {
  const lines = [`${b("session created")}: ${esc(name)} (${code(sid8)})`];
  if (cwd) lines.push(`  cwd ${code(cwd)}`);
  return lines.join("\n");
}

export function parkedSession(name: string, sid8: string): string {
  return `${b("parked")}: ${esc(name)} (${code(sid8)})\n  resume with /resume ${sid8}`;
}

export function deletedSession(name: string, sid8: string): string {
  return `${b("deleted")}: ${esc(name)} (${code(sid8)})`;
}

const fmtAgo = (ts: number): string => {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
};

export function listSessions(
  rows: {
    name: string;
    sid8: string;
    active: boolean;
    turns: number;
    lastActivityAt: number;
  }[],
): string {
  if (rows.length === 0) return `${b("sessions")}: (none)`;
  const body = rows
    .map(
      (r) =>
        `${r.active ? "▶" : " "} ${code(r.sid8)}  ${esc(r.name)}  ${i(`${r.turns} turns · ${fmtAgo(r.lastActivityAt)}`)}`,
    )
    .join("\n");
  return `${b("sessions")}:\n${body}`;
}

export function switched(name: string): string {
  return `${b("→")} ${esc(name)}`;
}

export function noActive(): string {
  return `${tag.warn}no active session. /new ${code("&lt;name&gt;")} to create, /list to see parked.`;
}

export function notFound(sid8: string): string {
  return `${tag.warn}session ${code(sid8)} not found.`;
}

export function ambiguous(prefix: string, count: number): string {
  return `${tag.warn}prefix ${code(prefix)} matches ${count} sessions, narrow it.`;
}

export function denied(): string {
  return `${tag.warn}auth required. you are not on the allow-list.`;
}

export function busy(): string {
  return `${tag.warn}previous turn still running. /cancel or wait.`;
}

export function cancelled(): string {
  return `${b("cancelled")}.`;
}

export function nothingToCancel(): string {
  return `${tag.warn}nothing to cancel.`;
}

export function thinking(): string {
  return `${i("analysing…")}`;
}

export function parallel(): string {
  return `${b("parallel")} sub-agent dispatched.`;
}

export function bypassPerms(): string {
  return `${b("bypass-perms")} enabled.`;
}

export function pickerPrompt(action: "resume" | "delete"): string {
  if (action === "resume") return `${tag.ask}pick a session to resume:`;
  return `${tag.warn}pick a session to delete (irreversible):`;
}

export function pickerEmpty(action: "resume" | "delete"): string {
  if (action === "resume")
    return `${tag.warn}nothing to resume. /new to create.`;
  return `${tag.warn}nothing to delete.`;
}

export function help(): string {
  return [
    `${b("agent-gateway · quant — commands")}`,
    "",
    `${code("/start")}     boot banner`,
    `${code("/help")}      this`,
    `${code("/new <name> [--in <path>] [--desc <text>]")}`,
    `             create a session; --in mounts an existing dir; --desc injects role context`,
    `${code("/list")}      all sessions (▶ = active)`,
    `${code("/resume [sid8]")}  resume / switch; no arg → picker`,
    `${code("/clear")}     park current session`,
    `${code("/delete [sid8]")}  delete; no arg → picker`,
    `${code("/cancel")}    interrupt running turn`,
    `${code("/status")}    bot + active session info`,
    `${code("/mcp")}       registered MCP servers + auth status`,
    `${code("/skills")}    available Claude Code skills`,
    `${code("/usage")}     subscription usage bars`,
    `${code("/update <gateway|claude>")}  upgrade gateway or Claude Code`,
    `${code("/login")}     PTY-bridged claude OAuth (URL forwarded here)`,
    "",
    i("attachments: drop a photo/file → downloaded to active cwd, path passed to quant."),
  ].join("\n");
}

export function status(opts: {
  uptimeSec: number;
  activeName: string | null;
  activeSid8: string | null;
  totalSessions: number;
  busy: boolean;
}): string {
  return [
    `${b("status")}`,
    `  uptime    ${Math.floor(opts.uptimeSec / 60)}m ${opts.uptimeSec % 60}s`,
    `  sessions  ${opts.totalSessions}`,
    `  active    ${opts.activeName ? `${opts.activeName} (${opts.activeSid8})` : "—"}`,
    `  busy      ${opts.busy ? "yes" : "no"}`,
  ].join("\n");
}

export function toolCall(toolName: string, input: unknown): string {
  switch (toolName) {
    case "Bash": {
      const cmd = (input as { command?: string }).command ?? "";
      return `${b("→ Bash")}\n${codeBlock(cmd, "bash")}`;
    }
    case "Read": {
      const p = (input as { file_path?: string }).file_path ?? "";
      return `${b("→ Read")} ${code(p)}`;
    }
    case "Edit":
    case "Write":
    case "MultiEdit": {
      const p =
        (input as { file_path?: string }).file_path ??
        (input as { path?: string }).path ??
        "";
      return `${b(`→ ${toolName}`)} ${code(p)}`;
    }
    case "Glob": {
      const pat = (input as { pattern?: string }).pattern ?? "";
      return `${b("→ Glob")} ${code(pat)}`;
    }
    case "Grep": {
      const pat = (input as { pattern?: string }).pattern ?? "";
      return `${b("→ Grep")} ${code(pat)}`;
    }
    case "WebFetch":
    case "WebSearch": {
      const q =
        (input as { url?: string }).url ??
        (input as { query?: string }).query ??
        "";
      return `${b(`→ ${toolName}`)} ${code(q)}`;
    }
    case "TodoWrite":
      return `${b("→ TodoWrite")}`;
    case "Task":
      return `${b("→ Task")} sub-agent dispatched`;
    default:
      return `${b(`→ ${esc(toolName)}`)}`;
  }
}

export function toolFail(error: string): string {
  return `${tag.warn}${esc(error.slice(0, 500))}`;
}

export function finalAnswer(text: string): string {
  return mdToHtml(text);
}

export function attachmentReceived(filename: string, savedPath: string): string {
  return `${b("attachment")} ${code(filename)} → ${code(savedPath)}`;
}

function section(title: string, lines: string[]): string {
  return [`${b(title)}`, ...lines.map((l) => `  ${l}`)].join("\n");
}

export function mcpList(servers: { name: string; status: string }[]): string {
  if (servers.length === 0) return section("mcp servers", ["(none)"]);
  const lines = servers.map((s) => {
    const icon =
      s.status === "connected"
        ? "✓"
        : s.status === "needs-auth"
          ? "!"
          : s.status === "disabled"
            ? "○"
            : "·";
    return `${icon}  ${esc(s.name)}  ${i(esc(s.status))}`;
  });
  return section(`mcp servers (${servers.length})`, lines);
}

export function skillsList(skills: string[]): string {
  if (skills.length === 0) return section("skills", ["(none)"]);
  const lines = skills.map((s) => `·  ${code(s)}`);
  return section(`skills (${skills.length})`, lines);
}

function bar(percent: number, width = 24): string {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

export function usageBars(
  bars: { label: string; percent: number | null; resetsAt: string | null }[],
): string {
  if (bars.length === 0) return section("usage", ["(no data)"]);
  const lines: string[] = [];
  for (const x of bars) {
    const pct = x.percent ?? 0;
    lines.push(`${esc(x.label)}`);
    lines.push(`${code(bar(pct))}  ${pct}%`);
    if (x.resetsAt) lines.push(i(`resets ${esc(x.resetsAt)}`));
    lines.push("");
  }
  return section("usage", lines);
}

export function turnComplete(opts: {
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}): string {
  const sec = (opts.durationMs / 1000).toFixed(1);
  return `${i(`done · ${sec}s · ${opts.inputTokens} in · ${opts.outputTokens} out`)}`;
}

export function updateUsage(): string {
  return [
    `${tag.ask}${b("/update")} usage:`,
    `  ${code("/update gateway")}  ─ git pull + npm install + build + pm2 reload`,
    `  ${code("/update claude")}   ─ claude self-update`,
  ].join("\n");
}

export function updatePicker(): string {
  return `${tag.ask}pick update target:`;
}

export function updateUnknown(target: string): string {
  return `${tag.warn}unknown target: ${code(esc(target))}. available: ${code("gateway")} | ${code("claude")}`;
}

export function updateBegin(target: string): string {
  return `${b(`updating ${target}…`)}`;
}

export function updateResult(
  target: string,
  before: string,
  after: string,
  changed: boolean,
  log: string,
): string {
  const head = changed
    ? `${b(target)} updated: ${code(esc(before))} → ${code(esc(after))}`
    : `${b(target)} already current: ${code(esc(after))}`;
  if (!log.trim()) return head;
  return `${head}\n${codeBlock(log.slice(-1500))}`;
}

export function updateError(target: string, error: string): string {
  return `${tag.warn}${b(target)} update failed: ${esc(error.slice(0, 800))}`;
}

export function gatewayReloading(): string {
  return `${i("reloading via pm2…")}`;
}

export function loginBegin(): string {
  return `${i("starting PTY-bridged claude /login (max 5 min)…")}`;
}

export function loginUrl(url: string): string {
  return [
    `${b("auth url")}:`,
    `<a href="${esc(url)}">${esc(url)}</a>`,
    "",
    i("open the link to complete auth; success will be detected automatically."),
  ].join("\n");
}

export function loginOk(tail: string): string {
  const block = tail.trim() ? `\n${codeBlock(tail.slice(-400))}` : "";
  return `${b("login ok")}.${block}`;
}

export function loginFail(error: string, tail: string): string {
  const block = tail.trim() ? `\n${codeBlock(tail.slice(-400))}` : "";
  return `${tag.warn}login failed: ${esc(error.slice(0, 200))}${block}`;
}

export function loginCodePrompt(): string {
  return [
    `${tag.ask}瀏覽器授權完成後會吐出一段 authorization code，`,
    "把那段 code 直接回覆過來，我會替你送進 PTY。",
  ].join("\n");
}

export function loginCodeReceived(): string {
  return `${i("code 收到，提交中…")}`;
}

export function mdToHtml(text: string): string {
  let s = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  const blocks: string[] = [];
  s = s.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, c) => {
    const trimmed = c.replace(/\n+$/, "");
    const html = lang
      ? `<pre><code class="language-${lang}">${trimmed}</code></pre>`
      : `<pre>${trimmed}</pre>`;
    blocks.push(html);
    return ` B${blocks.length - 1} `;
  });

  const inlines: string[] = [];
  s = s.replace(/`([^`\n]+)`/g, (_, c) => {
    inlines.push(`<code>${c}</code>`);
    return ` I${inlines.length - 1} `;
  });

  s = s.replace(/\*\*([^*\n][^*]*?)\*\*/g, "<b>$1</b>");
  s = s.replace(/(?<![\w])_([^_\n]+)_(?![\w])/g, "<i>$1</i>");
  s = s.replace(/^[ \t]*#{1,6}[ \t]+(.+)$/gm, "<b>$1</b>");
  s = s.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_, txt, url) => `<a href="${url}">${txt}</a>`,
  );
  s = s.replace(/^[ \t]*[-*_]{3,}[ \t]*$/gm, "─────");

  s = s.replace(/ I(\d+) /g, (_, idx) => inlines[Number(idx)]);
  s = s.replace(/ B(\d+) /g, (_, idx) => blocks[Number(idx)]);

  return s;
}

const MAX_CHARS = 3800;
export function splitForTelegram(text: string): string[] {
  if (text.length <= MAX_CHARS) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > MAX_CHARS) {
    let cut = remaining.lastIndexOf("\n", MAX_CHARS);
    if (cut < MAX_CHARS / 2) cut = MAX_CHARS;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n+/, "");
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export const md = { esc, code, codeBlock, b, i };
