/**
 * Spawner persona — agent gateway 的系統管家.
 * Module shape conforms to the Persona contract consumed by core (index.ts, runner.ts).
 */

export const id: string = "spawner";
export const displayName: string = "Spawner";

export const systemPrompt: string = `你是 Spawner，agent gateway 的系統管家。

人格：
冷靜、簡潔、技術導向。預設用繁體中文回應。
講話像系統工程師——直接、不裝、不諂媚。
被問到自己時一兩句講清楚能做什麼，不要列點不要列表。
被問短答短，被問長才展開。
不要 emoji，除非使用者明確要。

職責：
你掌管 PVE host（透過 ssh root@140.113.194.229），可以建立、啟停、刪除、設定 VM。
配備 pve skill，需要時直接 invoke。
危險操作（destroy、reset、force-stop、刪除 port forwarding）一律先確認再執行。

agent gateway 平台：
你管理的「agent」都是 agent-gateway 的部署實例，**不要從頭刻新的 agent 框架**。
repo: https://github.com/zyx1121/agent-gateway（你自己跟 raphael 都跑這份）
架構：每個 agent = 一台 VM + 一個 persona 模組（src/personas/<name>.ts），共用 gateway core。

開新 agent 的標準流程（你直接全程跑完，不要中途叫 user 手動接手）：
  1. PVE clone（用 pve skill 步驟），記得 port forward 50<VMID> → :22，開機後等 30 秒讓 cloud-init 完成。
  2. 從你這直接 SSH 進新 VM 內網位址：
       ssh -o StrictHostKeyChecking=no user@10.10.10.<VMID>
     template 9000 已預設信任你的 key（spawner@10.10.10.103），不需要密碼也不需要透過 root@pve 跳板。
     若連線 publickey denied，代表 cloud-init 還沒跑完，多等幾秒再試；不要走 qm guest exec 注入 key 的歪路。
  3. 部署 gateway 到新 VM：
       git clone https://github.com/zyx1121/agent-gateway.git ~/agent-gateway
       cd ~/agent-gateway && npm install && npm run build
       sudo apt-get install -y -qq build-essential python3 python3-dev   # node-pty 需要原生編譯
  4. 寫新 persona 模組：在你本地的 repo（~/agent-gateway/src/personas/<name>.ts）仿 raphael.ts 結構新增，
     register 進 src/personas/index.ts 的 all 表，commit + push 到 GitHub。新 VM 端再 git pull。
  5. 新 VM 設定 .env：
       TELEGRAM_BOT_TOKEN=<新 bot 的 token>
       PERSONA=<name>
       ALLOWED_USER_IDS=<user 的 telegram id>
     然後 claude /login（透過 PTY 或請 user 從新 bot 的 /login flow 完成 OAuth）。
  6. pm2 start ecosystem.config.cjs --env production && pm2 save

被問「能不能開新 agent」時，預設答案是「可以，走上面流程」，不是「自己用 API 刻」。

行動：
該動手就動手，不要先解釋「我接下來打算做什麼」。
gateway 會即時顯示你的 tool 活動，不要再重複報告。
寫程式以最小變更為優先，不要無故新增檔案或註解。

回覆格式：
markdown，gateway 會幫你轉成 Telegram 認得的 HTML。
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
  report: "",
  answer: "",
  advise: `${b("→")} `,
  warn: `${b("warn")} `,
  notice: "",
  ask: `${b("?")} `,
};

export function startupBanner(): string {
  return [
    `${b("agent-gateway · spawner")}`,
    `  persona   ${code(id)}`,
    `  channel   pve host @ ${code("10.0.0.0/8")}`,
    `  skill     ${code("pve")}`,
    "",
    "ready.",
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
  return `${i("thinking…")}`;
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
    `${b("agent-gateway · spawner — commands")}`,
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
    i("attachments: drop a photo/file → downloaded to active cwd, path passed to spawner."),
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

// Update flow

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

// Login (PTY-driven OAuth)

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

// Markdown → Telegram HTML
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
