/**
 * Framework messages for outpost.
 *
 * The bot speaks plain ASCII with minimal flourish — the agent's actual
 * personality lives in ~/.claude/CLAUDE.md on the host and arrives via the
 * channel. This file only does the framing for /start, /help, /status, and
 * the markdown→Telegram-HTML transform for claude's replies.
 *
 * Markers:
 *   >>  action  · ok / completed
 *   !!  warning · failure
 */

import { config } from "./config.js";

// ── HTML helpers (internal) ─────────────────────────────────────────

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const code = (s: string): string => `<code>${esc(s)}</code>`;

const b = (s: string): string => `<b>${s}</b>`;
const i = (s: string): string => `<i>${s}</i>`;

// ── framework messages ──────────────────────────────────────────────

export function startupBanner(): string {
  return `${b("outpost")} ${i("·")} ${esc(config.agentName)} ${i("·")} ready.`;
}

export function denied(): string {
  return `${b("!!")} auth required — you are not on the allow-list`;
}

export function help(): string {
  return [
    `${b("outpost · commands")}`,
    "",
    `${code("/start")}    boot banner`,
    `${code("/help")}     this`,
    `${code("/status")}   daemon uptime + claude state`,
    `${code("/clear")}    reset claude — kill + respawn, fresh conversation`,
    "",
    i("plain text → forwarded to claude as a turn."),
    i("photos / docs → downloaded to workspace, path passed in caption."),
    i("other /<cmd> (e.g. /plugin, /mcp) → forwarded to claude verbatim."),
  ].join("\n");
}

export function status(opts: {
  uptimeSec: number;
  claudePid: number | null;
  claudeRssBytes: number | null;
  msgsIn: number;
  msgsOut: number;
}): string {
  const mins = Math.floor(opts.uptimeSec / 60);
  const secs = opts.uptimeSec % 60;
  const rss = opts.claudeRssBytes
    ? ` · ${(opts.claudeRssBytes / 1024 / 1024).toFixed(0)} MB`
    : "";
  const claude = opts.claudePid ? `pid ${opts.claudePid}${rss}` : "down";
  return [
    `${b("status")}`,
    `   uptime    ${mins}m ${secs}s`,
    `   claude    ${claude}`,
    `   msgs      ${opts.msgsIn} in · ${opts.msgsOut} out`,
  ].join("\n");
}

export function toolFail(error: string): string {
  return `${b("!!")} ${esc(error.slice(0, 500))}`;
}

export function attachmentReceived(filename: string, savedPath: string): string {
  return `${b(">> attached")} ${code(filename)} -> ${code(savedPath)}`;
}

export function finalAnswer(text: string): string {
  return mdToHtml(text);
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
