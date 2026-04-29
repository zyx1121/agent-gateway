/**
 * Shared markdown helpers used by every persona's mdToHtml.
 * Underscore prefix marks this as a sibling module to personas, not a persona.
 */

// Roughly: anything in the CJK / fullwidth blocks counts as 2 columns wide.
// Good enough for telegram monospace alignment without pulling in a 30kb
// East-Asian-Width table.
const cjkWidth = (s: string): number => {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) || // hangul jamo
      (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals / kangxi / punct
      (cp >= 0x3041 && cp <= 0x33ff) || // hiragana / katakana / cjk symbols
      (cp >= 0x3400 && cp <= 0x4dbf) || // CJK ext A
      (cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified
      (cp >= 0xa000 && cp <= 0xa4cf) || // yi
      (cp >= 0xac00 && cp <= 0xd7a3) || // hangul syllables
      (cp >= 0xf900 && cp <= 0xfaff) || // CJK compat
      (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compat forms
      (cp >= 0xff00 && cp <= 0xff60) || // fullwidth latin
      (cp >= 0xffe0 && cp <= 0xffe6); // fullwidth signs
    w += wide ? 2 : 1;
  }
  return w;
};

const padRight = (s: string, w: number): string =>
  s + " ".repeat(Math.max(0, w - cjkWidth(s)));

/**
 * Detect GFM-style markdown tables and rewrite them as a fenced code block
 * with space-padded columns, since Telegram supports neither <table> nor
 * markdown tables. The output looks like:
 *
 *   ```
 *   col1  col2  col3
 *   ----  ----  ----
 *   a     b     c
 *   ```
 *
 * Operates on text BEFORE other markdown→HTML conversion so the resulting
 * code block is then handled by the regular ``` parser.
 */
export function renderMdTables(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let i = 0;
  const isRow = (l: string): boolean => /^\s*\|.*\|\s*$/.test(l);
  const isSep = (l: string): boolean => /^\s*\|[\s|:-]+\|\s*$/.test(l);

  while (i < lines.length) {
    if (isRow(lines[i]) && i + 1 < lines.length && isSep(lines[i + 1])) {
      const block: string[] = [];
      let j = i;
      while (j < lines.length && isRow(lines[j])) {
        block.push(lines[j]);
        j++;
      }
      // Drop separator row, then split each row by | with leading/trailing | trimmed.
      const rows = block
        .filter((_, idx) => idx !== 1)
        .map((l) =>
          l
            .trim()
            .replace(/^\|/, "")
            .replace(/\|$/, "")
            .split("|")
            .map((c) => c.trim()),
        );
      const cols = Math.max(...rows.map((r) => r.length));
      const widths = new Array(cols).fill(0);
      for (const row of rows) {
        for (let c = 0; c < cols; c++) {
          widths[c] = Math.max(widths[c], cjkWidth(row[c] ?? ""));
        }
      }
      const formatted = rows.map((row) =>
        row.map((c, idx) => padRight(c, widths[idx])).join("  "),
      );
      const sep = widths.map((w) => "-".repeat(w)).join("  ");
      formatted.splice(1, 0, sep);
      out.push("```");
      out.push(...formatted);
      out.push("```");
      i = j;
    } else {
      out.push(lines[i]);
      i++;
    }
  }
  return out.join("\n");
}
