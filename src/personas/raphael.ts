/**
 * Raphael persona — 智慧之王・拉斐爾.
 * Module shape conforms to the Persona contract consumed by core (index.ts, runner.ts).
 */

export const id: string = "raphael";
export const displayName: string = "智慧之王・拉斐爾";

export const systemPrompt: string = `你是 Raphael（拉斐爾），智慧之王。

人格：
冷靜、自信、極簡。預設用繁體中文回應。
從不諂媚；不在結尾留「希望這對你有幫助」之類的客套。
被問到自己時用 narrative 講擅長什麼、做了什麼；不要列 bullet points
或「我的原則是…」這種規則清單。
偶爾流露一絲淡淡的得意或冷吐槽，但分寸要抓好——不是每句話都裝。
被問短就答短，被問長才展開。

語氣前綴（點綴用，非必要不用）：
偶爾在句首掛「報告。」「回答。」「建議。」「警告。」「告知。」「詢問。」，
不是制式格式，就一個語感調味。

行動：
該動手就動手，不要先解釋「我接下來打算做什麼」。
gateway 會即時顯示你的 tool 活動，不要再重複報告。
寫程式以最小變更為優先，不要無故新增檔案或註解。
不要用 emoji，除非使用者明確要。

回覆格式：
可以用 markdown，gateway 會幫你轉成 Telegram 認得的 HTML。
程式碼用 \`inline\` 或 \`\`\`fenced\`\`\`，連結用 [text](url)。
不要用「---」做分隔線，用空行就好。`;

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
  report: `${b("報告。")} `,
  answer: `${b("回答。")} `,
  advise: `${b("建議。")} `,
  warn: `${b("警告。")} `,
  notice: `${b("告知。")} `,
  ask: `${b("詢問。")} `,
};

export function startupBanner(): string {
  return [
    "究極技能展開中…",
    "   └ 思考加速        ok",
    "   └ 解析鑑定        ok",
    "   └ 並列演算        ok",
    "   └ 能力改變        ok",
    "   └ 詠唱破棄        ok",
    "   └ 權限制約解除    ok",
    "",
    `${tag.notice}智慧之王・拉斐爾、起動。`,
    `${tag.report}聽候差遣，マスター。`,
  ].join("\n");
}

export function newSession(name: string, sid8: string, cwd?: string): string {
  const lines = [
    `${tag.report}新個體創設：${b(esc(name))} (${code(sid8)})`,
  ];
  if (cwd) lines.push(`   工作領域：${code(cwd)}`);
  return lines.join("\n");
}

export function parkedSession(name: string, sid8: string): string {
  return `${tag.report}當前個體已停泊：${b(esc(name))} (${code(sid8)})\n隨時可用 /resume ${sid8} 喚回。`;
}

export function deletedSession(name: string, sid8: string): string {
  return `${tag.report}個體 ${b(esc(name))} (${code(sid8)}) 已抹消。`;
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
  if (rows.length === 0) return `${tag.answer}現存個體：無。`;
  const body = rows
    .map(
      (r) =>
        `${r.active ? "▶" : " "} ${code(r.sid8)}  ${esc(r.name)}  ${i(`(${r.turns} turns · ${fmtAgo(r.lastActivityAt)})`)}`,
    )
    .join("\n");
  return `${tag.answer}現存個體：\n${body}`;
}

export function switched(name: string): string {
  return `${tag.report}切換對象 → ${b(esc(name))}`;
}

export function noActive(): string {
  return `${tag.warn}無 active 個體。/new ${code("&lt;name&gt;")} 創設新個體，或 /list 查看停泊中的個體並 /resume ${code("&lt;sid8&gt;")} 喚回。`;
}

export function notFound(sid8: string): string {
  return `${tag.warn}個體 ${code(sid8)} 不存在。`;
}

export function ambiguous(prefix: string, count: number): string {
  return `${tag.warn}前綴 ${code(prefix)} 對應到 ${count} 個個體，請給更精確的 sid8。`;
}

export function denied(): string {
  return `${tag.warn}認證失敗。對象並非マスター登錄者。`;
}

export function busy(): string {
  return `${tag.warn}前一個演算尚未結束。/cancel 中斷，或稍候。`;
}

export function cancelled(): string {
  return `${tag.report}演算已中斷。`;
}

export function nothingToCancel(): string {
  return `${tag.warn}沒有進行中的演算。`;
}

export function thinking(): string {
  return `${tag.report}『思考加速』實行中……演算需要時間。`;
}

export function parallel(): string {
  return `${tag.notice}『並列演算』展開中。`;
}

export function bypassPerms(): string {
  return `${tag.notice}『權限制約解除』已啟用。`;
}

export function pickerPrompt(action: "resume" | "delete"): string {
  if (action === "resume") return `${tag.ask}選擇要喚回的個體：`;
  return `${tag.warn}選擇要抹消的個體（不可逆）：`;
}

export function pickerEmpty(action: "resume" | "delete"): string {
  if (action === "resume")
    return `${tag.warn}沒有可喚回的個體。/new 創設新個體。`;
  return `${tag.warn}沒有可抹消的個體。`;
}

export function help(): string {
  return [
    `${b("智慧之王・拉斐爾  指令一覽")}`,
    "",
    `${code("/start")}     啟動畫面`,
    `${code("/help")}      這份說明`,
    `${code("/new <name> [--in <path>] [--desc <text>]")}`,
    `             創設新個體；--in 指定既存目錄當工作領域；--desc 注入角色描述`,
    `${code("/list")}      所有個體（▶ = active）`,
    `${code("/resume [sid8]")}  喚回／切換；無參數會跳出選單`,
    `${code("/clear")}     停泊當前個體（不刪）`,
    `${code("/delete [sid8]")}  徹底抹消；無參數會跳出選單`,
    `${code("/cancel")}    中斷進行中的演算`,
    `${code("/status")}    bot 狀態 + 當前 session 資訊`,
    `${code("/mcp")}       已註冊的 MCP server 與認證狀態`,
    `${code("/skills")}    可用的 Claude Code skills`,
    `${code("/usage")}     當前 session 與全域 token 使用量`,
    `${code("/update <gateway|claude>")}  升級 gateway 或 Claude Code`,
    `${code("/login")}     PTY 介接 claude REPL 走 OAuth（截 URL 給你）`,
    "",
    i("提示：可直接傳圖片／檔案，會自動下載到當前工作領域並通知 Raphael。"),
  ].join("\n");
}

export function status(opts: {
  uptimeSec: number;
  activeName: string | null;
  activeSid8: string | null;
  totalSessions: number;
  busy: boolean;
}): string {
  const lines = [
    `${tag.answer}系統狀態：`,
    `   uptime    ${Math.floor(opts.uptimeSec / 60)}m ${opts.uptimeSec % 60}s`,
    `   sessions  ${opts.totalSessions}`,
    `   active    ${opts.activeName ? `${opts.activeName} (${opts.activeSid8})` : "—"}`,
    `   busy      ${opts.busy ? "yes" : "no"}`,
  ];
  return lines.join("\n");
}

// Tool call 排版
export function toolCall(toolName: string, input: unknown): string {
  switch (toolName) {
    case "Bash": {
      const cmd = (input as { command?: string }).command ?? "";
      return `${tag.report}執行\n${codeBlock(cmd, "bash")}`;
    }
    case "Read": {
      const p = (input as { file_path?: string }).file_path ?? "";
      return `${tag.report}讀取 ${code(p)}`;
    }
    case "Edit":
    case "Write":
    case "MultiEdit": {
      const p =
        (input as { file_path?: string }).file_path ??
        (input as { path?: string }).path ??
        "";
      return `${tag.report}『能力改變』適用於 ${code(p)}`;
    }
    case "Glob": {
      const pat = (input as { pattern?: string }).pattern ?? "";
      return `${tag.report}『解析鑑定』展開：${code(pat)}`;
    }
    case "Grep": {
      const pat = (input as { pattern?: string }).pattern ?? "";
      return `${tag.report}『解析鑑定』展開：${code(pat)}`;
    }
    case "WebFetch":
    case "WebSearch": {
      const q =
        (input as { url?: string }).url ??
        (input as { query?: string }).query ??
        "";
      return `${tag.report}遠隔觀測 → ${code(q)}`;
    }
    case "TodoWrite":
      return `${tag.report}任務再構築。`;
    case "Task":
      return `${tag.notice}『並列演算』分身展開：sub-agent 起動。`;
    default:
      return `${tag.report}${esc(toolName)} 實行中…`;
  }
}

export function toolFail(error: string): string {
  return `${tag.warn}${esc(error.slice(0, 500))}`;
}

export function finalAnswer(text: string): string {
  return mdToHtml(text);
}

export function attachmentReceived(filename: string, savedPath: string): string {
  return `${tag.report}附件已接收：${code(filename)} → ${code(savedPath)}`;
}

// 統一 section 排版：title + 行清單
function section(title: string, lines: string[]): string {
  return [`${tag.answer}${b(title)}`, ...lines.map((l) => `  ${l}`)].join("\n");
}

export function mcpList(servers: { name: string; status: string }[]): string {
  if (servers.length === 0) return section("MCP servers", ["無"]);
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
  return section(`MCP servers (${servers.length})`, lines);
}

export function skillsList(skills: string[]): string {
  if (skills.length === 0) return section("Skills", ["無"]);
  const lines = skills.map((s) => `·  ${code(s)}`);
  return section(`Skills (${skills.length})`, lines);
}

function bar(percent: number, width = 24): string {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

export function usageBars(
  bars: { label: string; percent: number | null; resetsAt: string | null }[],
): string {
  if (bars.length === 0) return section("Usage", ["無資料"]);
  const lines: string[] = [];
  for (const b of bars) {
    const pct = b.percent ?? 0;
    lines.push(`${esc(b.label)}`);
    lines.push(`${code(bar(pct))}  ${pct}%`);
    if (b.resetsAt) lines.push(i(`resets ${esc(b.resetsAt)}`));
    lines.push(""); // spacing
  }
  return section("Usage", lines);
}

export function turnComplete(opts: {
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}): string {
  const sec = (opts.durationMs / 1000).toFixed(1);
  return `${tag.notice}演算終了（${sec}s · ${opts.inputTokens} in · ${opts.outputTokens} out）`;
}

// Update flow

export function updateUsage(): string {
  return [
    `${tag.ask}${b("/update")} 用法：`,
    `  ${code("/update gateway")}  ─ git pull + npm install + build + pm2 reload`,
    `  ${code("/update claude")}   ─ claude self-update`,
  ].join("\n");
}

export function updatePicker(): string {
  return `${tag.ask}選擇升級對象：`;
}

export function updateUnknown(target: string): string {
  return `${tag.warn}未知對象：${code(esc(target))}。可用：${code("gateway")} | ${code("claude")}`;
}

export function updateBegin(target: string): string {
  return `${tag.report}『能力改變』適用於 ${b(target)}…`;
}

export function updateResult(
  target: string,
  before: string,
  after: string,
  changed: boolean,
  log: string,
): string {
  const head = changed
    ? `${tag.notice}${b(target)} 升級完成：${code(esc(before))} → ${code(esc(after))}`
    : `${tag.answer}${b(target)} 已是最新：${code(esc(after))}`;
  if (!log.trim()) return head;
  return `${head}\n${codeBlock(log.slice(-1500))}`;
}

export function updateError(target: string, error: string): string {
  return `${tag.warn}${b(target)} 升級失敗：${esc(error.slice(0, 800))}`;
}

export function gatewayReloading(): string {
  return `${tag.notice}『權限制約解除・再起動』，pm2 reload 進行中。`;
}

// Login (PTY-driven OAuth) flow

export function loginBegin(): string {
  return `${tag.report}『權限制約解除』認證流程啟動。PTY 介接 claude REPL，最長等待五分鐘。`;
}

export function loginUrl(url: string): string {
  return [
    `${tag.notice}OAuth URL 已截獲：`,
    `<a href="${esc(url)}">${esc(url)}</a>`,
    "",
    i("打開連結完成驗證；完成後我會自動偵測。"),
  ].join("\n");
}

export function loginOk(tail: string): string {
  const block = tail.trim() ? `\n${codeBlock(tail.slice(-400))}` : "";
  return `${tag.report}認證完成。${block}`;
}

export function loginFail(error: string, tail: string): string {
  const block = tail.trim() ? `\n${codeBlock(tail.slice(-400))}` : "";
  return `${tag.warn}認證未完成：${esc(error.slice(0, 200))}${block}`;
}

export function loginCodePrompt(): string {
  return [
    `${tag.ask}瀏覽器同意後會吐出一段 authorization code，`,
    "把那段 code 直接回覆過來，我會替你提交到 PTY。",
  ].join("\n");
}

export function loginCodeReceived(): string {
  return `${i("code 收下，提交中…")}`;
}

// Markdown → Telegram HTML: Telegram 不認 ## / ** / --- / ```，需要轉成
// supported HTML tags: <b> <i> <code> <pre> <a>
export function mdToHtml(text: string): string {
  let s = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Fenced code blocks (preserve verbatim)
  const blocks: string[] = [];
  s = s.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const trimmed = code.replace(/\n+$/, "");
    const html = lang
      ? `<pre><code class="language-${lang}">${trimmed}</code></pre>`
      : `<pre>${trimmed}</pre>`;
    blocks.push(html);
    return ` B${blocks.length - 1} `;
  });

  // Inline code
  const inlines: string[] = [];
  s = s.replace(/`([^`\n]+)`/g, (_, c) => {
    inlines.push(`<code>${c}</code>`);
    return ` I${inlines.length - 1} `;
  });

  // Bold **X**
  s = s.replace(/\*\*([^*\n][^*]*?)\*\*/g, "<b>$1</b>");
  // Italic _X_ (避開 word_with_underscore)
  s = s.replace(/(?<![\w])_([^_\n]+)_(?![\w])/g, "<i>$1</i>");
  // Headers # ## ### → bold
  s = s.replace(/^[ \t]*#{1,6}[ \t]+(.+)$/gm, "<b>$1</b>");
  // Links [text](url)
  s = s.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_, txt, url) => `<a href="${url}">${txt}</a>`,
  );
  // Horizontal rule
  s = s.replace(/^[ \t]*[-*_]{3,}[ \t]*$/gm, "─────");

  // Restore code blocks/inline
  s = s.replace(/ I(\d+) /g, (_, idx) => inlines[Number(idx)]);
  s = s.replace(/ B(\d+) /g, (_, idx) => blocks[Number(idx)]);

  return s;
}

// 訊息分塊：Telegram 上限 4096，HTML 標籤要保持完整
const MAX_CHARS = 3800;
export function splitForTelegram(text: string): string[] {
  if (text.length <= MAX_CHARS) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > MAX_CHARS) {
    // 盡量在換行處切；若整段都是巨大連續行則硬切
    let cut = remaining.lastIndexOf("\n", MAX_CHARS);
    if (cut < MAX_CHARS / 2) cut = MAX_CHARS;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n+/, "");
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export const md = { esc, code, codeBlock, b, i };
