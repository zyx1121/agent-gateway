import "dotenv/config";
import { accessSync, constants } from "node:fs";

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

// /run is the obvious place for a system socket but isn't always writable
// (user-mode daemons, macOS dev boxes). Fall back to $HOME so the daemon
// still boots; in prod set OUTPOST_SOCK explicitly to wherever fits.
const defaultSocketPath = (): string => {
  try {
    accessSync("/run", constants.W_OK);
    return "/run/outpost.sock";
  } catch {
    return `${process.env.HOME ?? "/tmp"}/outpost.sock`;
  }
};

export const config = {
  botToken: required("TELEGRAM_BOT_TOKEN"),
  allowedUsers: csvIds("ALLOWED_USER_IDS"),
  agentName: process.env.AGENT_NAME ?? "agent",
  claudeBin: process.env.CLAUDE_BIN ?? "claude",
  socketPath: process.env.OUTPOST_SOCK ?? defaultSocketPath(),
  workspace: process.env.CLAUDE_WORKSPACE ?? `${process.env.HOME}/outpost-data`,
};

if (config.allowedUsers.size === 0) {
  console.warn(
    "[warn] ALLOWED_USER_IDS is empty — bot will reject every user.",
  );
}
