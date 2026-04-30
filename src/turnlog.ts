import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// dist/turnlog.js → repo root → repo/logs/turns.jsonl
const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PATH = `${REPO_DIR}/logs/turns.jsonl`;
const MAX_BYTES_RETURNED = 64 * 1024;
const MAX_TEXT_PER_FIELD = 4000;

export interface TurnRecord {
  ts: number;
  chatId: number;
  userId: number;
  sessionId: string;
  kind: "start" | "tool" | "answer" | "end" | "error";
  prompt?: string;
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  error?: string;
}

const truncate = (s: string | undefined, n = MAX_TEXT_PER_FIELD): string | undefined =>
  s == null ? undefined : s.length <= n ? s : s.slice(0, n) + `…[+${s.length - n}]`;

export async function logTurn(rec: TurnRecord): Promise<void> {
  try {
    await mkdir(dirname(LOG_PATH), { recursive: true });
    const sanitized: TurnRecord = {
      ...rec,
      prompt: truncate(rec.prompt),
      text: truncate(rec.text),
      error: truncate(rec.error, 1000),
    };
    await appendFile(LOG_PATH, JSON.stringify(sanitized) + "\n");
  } catch {
    /* don't let logging break a turn */
  }
}

export function tailTurns(n: number): TurnRecord[] {
  if (!existsSync(LOG_PATH)) return [];
  // Read up to MAX_BYTES_RETURNED from the tail to avoid loading multi-MB logs.
  const stat = readFileSync(LOG_PATH);
  const slice =
    stat.length <= MAX_BYTES_RETURNED
      ? stat.toString("utf8")
      : stat.subarray(stat.length - MAX_BYTES_RETURNED).toString("utf8");
  // Drop a possibly-partial first line after the slice.
  const lines = slice.split("\n").filter((l) => l.trim());
  const tail = lines.slice(-n);
  const out: TurnRecord[] = [];
  for (const line of tail) {
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip malformed */
    }
  }
  return out;
}
