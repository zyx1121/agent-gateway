import "dotenv/config";
import { accessSync, constants } from "node:fs";

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

// No throws at module-load time. Required fields default to empty/zero;
// the daemon's boot path validates them and exits cleanly with a clear
// message. Keeping this side-effect-free means subcommands that don't
// need the daemon (e.g. `outpost inject`) can import config-adjacent
// modules without crashing on a missing TELEGRAM_BOT_TOKEN.
export const config = {
  botToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
  allowedUsers: csvIds("ALLOWED_USER_IDS"),
  agentName: process.env.AGENT_NAME ?? "agent",
  claudeBin: process.env.CLAUDE_BIN ?? "claude",
  socketPath: process.env.OUTPOST_SOCK ?? defaultSocketPath(),
  workspace: process.env.CLAUDE_WORKSPACE ?? `${process.env.HOME}/outpost-data`,
};
