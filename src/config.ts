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

export const config = {
  botToken: required("TELEGRAM_BOT_TOKEN"),
  allowedUsers: csvIds("ALLOWED_USER_IDS"),
  persona: process.env.PERSONA ?? "raphael",
  claudeBin: process.env.CLAUDE_BIN ?? "claude",
  agentHome: process.env.AGENT_HOME ?? `${process.env.HOME}/agents`,
  sessionsFile:
    process.env.SESSIONS_FILE ??
    `${process.env.HOME}/agent-gateway/sessions.json`,
};

if (config.allowedUsers.size === 0) {
  console.warn(
    "[warn] ALLOWED_USER_IDS is empty — bot will reject every user.",
  );
}
