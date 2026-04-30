/**
 * Framework messages for agent-gateway.
 *
 * Style philosophy: gateway speaks like a retro terminal — plain English,
 * pure ASCII, no flourish. The "personality" of an agent comes from the
 * Claude Code side reading ~/CLAUDE.md, not from this layer.
 *
 * Markers:
 *   >>  action / tool invocation / switch target
 *   !!  warning / failure
 *   ->  redirect (used inline)
 */

import { config } from "./config.js";

// ── HTML helpers ────────────────────────────────────────────────────

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const code = (s: string): string => `<code>${esc(s)}</code>`;

const codeBlock = (s: string, lang = ""): string =>
  lang
    ? `<pre><code class="language-${lang}">${esc(s)}</code></pre>`
    : `<pre>${esc(s)}</pre>`;

const b = (s: string): string => `<b>${s}</b>`;
const i = (s: string): string => `<i>${s}</i>`;

export const md = { esc, code, codeBlock, b, i };

export const displayName: string = config.agentName;

// ── boot ────────────────────────────────────────────────────────────

export function startupBanner(): string {
  return `${b("agent-gateway")} ${i("·")} ${esc(config.agentName)} ${i("·")} ready.`;
}

// ── session lifecycle ───────────────────────────────────────────────

export function newSession(name: string, sid8: string, cwd: string): string {
  return [
    `${b(">> session created")} ${esc(name)} ${code(sid8)}`,
    `   cwd ${code(cwd)}`,
  ].join("\n");
}

export function parkedSession(name: string, sid8: string): string {
  return `${b(">> parked")} ${esc(name)} ${code(sid8)} — /resume ${sid8} to bring back`;
}

export function deletedSession(name: string, sid8: string): string {
  return `${b(">> deleted")} ${esc(name)} ${code(sid8)}`;
}

export function deletedAll(count: number): string {
  if (count === 0) return `${b("!!")} nothing to delete`;
  return `${b(">> deleted all")} ${count} session${count === 1 ? "" : "s"}`;
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
  if (rows.length === 0) return `${b("sessions")} (none)`;
  const body = rows
    .map(
      (r) =>
        `${r.active ? "*" : " "} ${code(r.sid8)}  ${esc(r.name)}  ${i(`${r.turns} turns · ${fmtAgo(r.lastActivityAt)}`)}`,
    )
    .join("\n");
  return `${b("sessions")}\n${body}`;
}

export function switched(name: string): string {
  return `${b(">>")} ${esc(name)}`;
}

// ── error / state ───────────────────────────────────────────────────

export function noActive(): string {
  return `${b("!!")} no active session — /new ${code("&lt;name&gt;")} to create, /list to see parked.`;
}

export function notFound(sid8: string): string {
  return `${b("!!")} session ${code(sid8)} not found`;
}

export function ambiguous(prefix: string, count: number): string {
  return `${b("!!")} prefix ${code(prefix)} matches ${count} sessions, narrow it`;
}

export function denied(): string {
  return `${b("!!")} auth required — you are not on the allow-list`;
}

export function busy(): string {
  return `${b("!!")} previous turn still running — /cancel or wait`;
}

export function cancelled(): string {
  return `${b(">> cancelled")}`;
}

export function nothingToCancel(): string {
  return `${b("!!")} nothing to cancel`;
}

// ── pickers ─────────────────────────────────────────────────────────

export function pickerPrompt(action: "resume" | "delete"): string {
  if (action === "resume") return `pick a session to resume:`;
  return `${b("!!")} pick a session to delete (irreversible):`;
}

export function pickerEmpty(action: "resume" | "delete"): string {
  if (action === "resume") return `${b("!!")} nothing to resume — /new to create`;
  return `${b("!!")} nothing to delete`;
}

// ── help / status ───────────────────────────────────────────────────

export function help(): string {
  return [
    `${b("agent-gateway · commands")}`,
    "",
    `${code("/start")}     boot banner`,
    `${code("/help")}      this`,
    `${code("/new <name> [--in <path>]")}`,
    `             create a session; default cwd = $HOME so ~/CLAUDE.md drives the agent`,
    `${code("/list")}      all sessions (* = active)`,
    `${code("/resume [sid8]")}  resume / switch; no arg → picker`,
    `${code("/clear")}     park current session`,
    `${code("/delete [sid8|all]")}  delete one / all; no arg → picker`,
    `${code("/cancel")}    interrupt running turn`,
    `${code("/status")}    bot + active session info`,
    `${code("/mcp")}       registered MCP servers + auth status`,
    `${code("/skills")}    available Claude Code skills`,
    `${code("/usage")}     subscription usage bars`,
    `${code("/update <gateway|claude>")}  upgrade gateway or Claude Code`,
    `${code("/login")}     PTY-bridged claude OAuth (URL forwarded here)`,
    `${code("/trace [N]")}  last N turn-log events (default 10)`,
    "",
    i(`attachments: drop a photo/file → downloaded to active cwd, path passed to agent.`),
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
    `   uptime    ${Math.floor(opts.uptimeSec / 60)}m ${opts.uptimeSec % 60}s`,
    `   sessions  ${opts.totalSessions}`,
    `   active    ${opts.activeName ? `${esc(opts.activeName)} (${opts.activeSid8})` : "—"}`,
    `   busy      ${opts.busy ? "yes" : "no"}`,
  ].join("\n");
}

// ── tool stream ─────────────────────────────────────────────────────

export function toolCall(toolName: string, input: unknown): string {
  switch (toolName) {
    case "Bash": {
      const cmd = (input as { command?: string }).command ?? "";
      return `${b(">> Bash")}\n${codeBlock(cmd, "bash")}`;
    }
    case "Read": {
      const p = (input as { file_path?: string }).file_path ?? "";
      return `${b(">> Read")} ${code(p)}`;
    }
    case "Edit":
    case "Write":
    case "MultiEdit": {
      const p =
        (input as { file_path?: string }).file_path ??
        (input as { path?: string }).path ??
        "";
      return `${b(`>> ${toolName}`)} ${code(p)}`;
    }
    case "Glob": {
      const pat = (input as { pattern?: string }).pattern ?? "";
      return `${b(">> Glob")} ${code(pat)}`;
    }
    case "Grep": {
      const pat = (input as { pattern?: string }).pattern ?? "";
      return `${b(">> Grep")} ${code(pat)}`;
    }
    case "WebFetch":
    case "WebSearch": {
      const q =
        (input as { url?: string }).url ??
        (input as { query?: string }).query ??
        "";
      return `${b(`>> ${toolName}`)} ${code(q)}`;
    }
    case "TodoWrite":
      return `${b(">> TodoWrite")}`;
    case "Task":
      return `${b(">> Task")} ${i("sub-agent dispatched")}`;
    default:
      return `${b(`>> ${esc(toolName)}`)}`;
  }
}

export function toolFail(error: string): string {
  return `${b("!!")} ${esc(error.slice(0, 500))}`;
}

export function finalAnswer(text: string): string {
  return mdToHtml(text);
}

export function attachmentReceived(filename: string, savedPath: string): string {
  return `${b(">> attached")} ${code(filename)} -> ${code(savedPath)}`;
}

// ── probes ──────────────────────────────────────────────────────────

function section(title: string, lines: string[]): string {
  return [`${b(title)}`, ...lines.map((l) => `   ${l}`)].join("\n");
}

export function mcpList(servers: { name: string; status: string }[]): string {
  if (servers.length === 0) return section("mcp servers", ["(none)"]);
  const lines = servers.map((s) => {
    const icon =
      s.status === "connected"
        ? "+"
        : s.status === "needs-auth"
          ? "!"
          : s.status === "disabled"
            ? "x"
            : "-";
    return `${icon}  ${esc(s.name)}  ${i(esc(s.status))}`;
  });
  return section(`mcp servers (${servers.length})`, lines);
}

export function skillsList(skills: string[]): string {
  if (skills.length === 0) return section("skills", ["(none)"]);
  const lines = skills.map((s) => `-  ${code(s)}`);
  return section(`skills (${skills.length})`, lines);
}

function bar(percent: number, width = 24): string {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
  return "#".repeat(filled) + ".".repeat(width - filled);
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

// ── update flow ─────────────────────────────────────────────────────

export function updatePicker(): string {
  return `pick update target:`;
}

export function updateUnknown(target: string): string {
  return `${b("!!")} unknown target: ${code(esc(target))} — available: ${code("gateway")} | ${code("claude")}`;
}

export function updateBegin(target: string): string {
  return `${b(`>> updating ${target}…`)}`;
}

export function updateResult(
  target: string,
  before: string,
  after: string,
  changed: boolean,
  log: string,
): string {
  const head = changed
    ? `${b(target)} updated: ${code(esc(before))} -> ${code(esc(after))}`
    : `${b(target)} already current: ${code(esc(after))}`;
  if (!log.trim()) return head;
  return `${head}\n${codeBlock(log.slice(-1500))}`;
}

export function updateError(target: string, error: string): string {
  return `${b("!!")} ${b(target)} update failed: ${esc(error.slice(0, 800))}`;
}

export function gatewayReloading(): string {
  return `${i("reloading via pm2…")}`;
}

// ── login flow (PTY OAuth) ──────────────────────────────────────────

export function loginBegin(): string {
  return `${i("starting PTY-bridged claude /login (max 5 min)…")}`;
}

export function loginUrl(url: string): string {
  return [
    `${b(">> auth url")}`,
    `<a href="${esc(url)}">${esc(url)}</a>`,
    "",
    i(`open the link to complete auth; success will be detected automatically.`),
  ].join("\n");
}

export function loginOk(tail: string): string {
  const block = tail.trim() ? `\n${codeBlock(tail.slice(-400))}` : "";
  return `${b(">> login ok")}${block}`;
}

export function loginFail(error: string, tail: string): string {
  const block = tail.trim() ? `\n${codeBlock(tail.slice(-400))}` : "";
  return `${b("!!")} login failed: ${esc(error.slice(0, 200))}${block}`;
}

export function loginCodePrompt(): string {
  return [
    `paste the authorization code here as the next message;`,
    `I'll forward it to the claude REPL.`,
  ].join("\n");
}

export function loginCodeReceived(): string {
  return `${i("code received, submitting…")}`;
}

// ── markdown → telegram HTML ────────────────────────────────────────

/**
 * Telegram supports neither <table> nor markdown tables, and its monospace
 * font does not place CJK at exactly 2× latin width. So instead of pretending
 * to render a table, we flatten each row into a card:
 *
 *   **<col0>** <col1>
 *     <header2>: <col2>
 *     <header3>: <col3>
 *
 * The first column becomes the bolded title; if a second column exists it
 * follows on the same line. Remaining columns become "header: value" lines.
 */
function renderMdTables(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let idx = 0;
  const isRow = (l: string): boolean => /^\s*\|.*\|\s*$/.test(l);
  const isSep = (l: string): boolean => /^\s*\|[\s|:-]+\|\s*$/.test(l);
  const splitCells = (l: string): string[] =>
    l
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());

  while (idx < lines.length) {
    if (isRow(lines[idx]) && idx + 1 < lines.length && isSep(lines[idx + 1])) {
      const block: string[] = [];
      let j = idx;
      while (j < lines.length && isRow(lines[j])) {
        block.push(lines[j]);
        j++;
      }
      const headers = splitCells(block[0]);
      const dataRows = block.slice(2).map(splitCells);

      for (const row of dataRows) {
        const title: string[] = [];
        if (row[0]) title.push(`**${row[0]}**`);
        if (row.length >= 2 && row[1]) title.push(row[1]);
        if (title.length) out.push(title.join(" "));

        for (let c = 2; c < row.length; c++) {
          const h = (headers[c] ?? "").trim();
          const v = (row[c] ?? "").trim();
          if (!v) continue;
          out.push(h ? `  ${h}: ${v}` : `  ${v}`);
        }
        out.push("");
      }
      while (out.length && out[out.length - 1] === "") out.pop();
      idx = j;
    } else {
      out.push(lines[idx]);
      idx++;
    }
  }
  return out.join("\n");
}

export function mdToHtml(text: string): string {
  let s = renderMdTables(text)
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

  s = s.replace(/ I(\d+) /g, (_, n) => inlines[Number(n)]);
  s = s.replace(/ B(\d+) /g, (_, n) => blocks[Number(n)]);

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
