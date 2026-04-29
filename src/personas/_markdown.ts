/**
 * Shared markdown helpers used by every persona's mdToHtml.
 * Underscore prefix marks this as a sibling module to personas, not a persona.
 */

/**
 * Telegram supports neither <table> nor markdown tables, and its monospace
 * font does not place CJK at exactly 2× latin width — space-padded columns
 * never line up cleanly across desktop / mobile. So instead of pretending
 * to render a table, we flatten each row into a card:
 *
 *   **<col0>** <col1>
 *     <header2>: <col2>
 *     <header3>: <col3>
 *
 * The first column becomes the bolded title; if a second column exists it
 * follows on the same line. Remaining columns are emitted as
 * "header: value" lines so any width works and inline markdown like
 * **bold** inside cells still gets honored by the downstream pipeline.
 */
export function renderMdTables(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let i = 0;
  const isRow = (l: string): boolean => /^\s*\|.*\|\s*$/.test(l);
  const isSep = (l: string): boolean => /^\s*\|[\s|:-]+\|\s*$/.test(l);
  const splitCells = (l: string): string[] =>
    l
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());

  while (i < lines.length) {
    if (isRow(lines[i]) && i + 1 < lines.length && isSep(lines[i + 1])) {
      const block: string[] = [];
      let j = i;
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
      i = j;
    } else {
      out.push(lines[i]);
      i++;
    }
  }
  return out.join("\n");
}
