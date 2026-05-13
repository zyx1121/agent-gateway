import "dotenv/config";

const required = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`missing env: ${name}`);
  return v;
};

const csvIds = (name: string): Set<number> => {
  const raw = process.env[name] ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => Number(s))
      .filter(Number.isFinite),
  );
};

// Accepts plain ms or "5m" / "30s" / "1h" / "90m" suffixed shorthand.
// Falls back if env is unset, empty, or unparsable so the bot still boots
// instead of crashing on a typo'd .env line.
const durationMs = (name: string, fallbackMs: number): number => {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return fallbackMs;
  const m = /^(\d+)\s*(ms|s|m|h)?$/.exec(raw);
  if (!m) {
    console.warn(`[warn] ${name}="${raw}" is unparsable, using ${fallbackMs}ms`);
    return fallbackMs;
  }
  const n = Number(m[1]);
  switch (m[2]) {
    case "h": return n * 3_600_000;
    case "m": return n * 60_000;
    case "s": return n * 1_000;
    case "ms":
    case undefined: return n;
    default: return fallbackMs;
  }
};

export const config = {
  botToken: required("TELEGRAM_BOT_TOKEN"),
  allowedUsers: csvIds("ALLOWED_USER_IDS"),
  agentName: process.env.AGENT_NAME ?? "agent",
  claudeBin: process.env.CLAUDE_BIN ?? "claude",
  sessionsFile:
    process.env.SESSIONS_FILE ??
    `${process.env.HOME}/agent-gateway/sessions.json`,
  // Idle timeout — kill if no stdout event for this long.
  // Long-running turns that keep streaming tool calls stay alive; only
  // genuinely stuck agents get reaped.
  idleTimeoutMs: durationMs("IDLE_TIMEOUT", 5 * 60_000),
  // Hard wall-clock cap as a circuit breaker.
  hardTimeoutMs: durationMs("HARD_TIMEOUT", 30 * 60_000),
};

if (config.allowedUsers.size === 0) {
  console.warn(
    "[warn] ALLOWED_USER_IDS is empty — bot will reject every user.",
  );
}
