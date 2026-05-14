import * as pty from "node-pty";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";

const RESTART_BACKOFF_MS = 2_000;
const RESTART_MAX_MS = 30_000;

export class Supervisor {
  private term: pty.IPty | null = null;
  private stopping = false;
  private nextBackoff = RESTART_BACKOFF_MS;

  async start(): Promise<void> {
    await this.seedWorkspace();
    await this.seedClaudeJson();
    this.spawn();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.term) {
      try {
        this.term.kill();
      } catch {
        /* already dead */
      }
      this.term = null;
    }
  }

  // Kill the current claude without setting `stopping` — onExit's backoff
  // timer respawns a fresh session. Used by the bot's /clear handler.
  restart(): void {
    this.nextBackoff = RESTART_BACKOFF_MS;
    if (!this.term) {
      this.spawn();
      return;
    }
    try {
      this.term.kill();
    } catch {
      /* already dead */
    }
  }

  private async seedWorkspace(): Promise<void> {
    const ws = config.workspace;
    await mkdir(ws, { recursive: true });
    await mkdir(`${ws}/.claude`, { recursive: true });

    // Channel runs under bun. Using `command: "bun", args: [path]` avoids
    // needing +x on the .ts file and works the same on Linux and macOS.
    // dist/ is one level deep so just one `..` up to repo root.
    const here = dirname(fileURLToPath(import.meta.url));
    const channelPath = resolve(here, "..", "channel", "channel.ts");
    await writeFile(
      `${ws}/.mcp.json`,
      JSON.stringify(
        {
          mcpServers: {
            "outpost-channel": {
              command: "bun",
              args: [channelPath],
              env: { OUTPOST_SOCK: config.socketPath },
            },
          },
        },
        null,
        2,
      ),
    );

    // Bypass mode so any tool (including newly-loaded MCP servers we
    // didn't pre-allowlist) just runs. The warning dialog this triggers
    // is dismissed in onData below via PTY arrow+enter.
    await writeFile(
      `${ws}/.claude/settings.local.json`,
      JSON.stringify(
        {
          permissions: { defaultMode: "bypassPermissions" },
          enableAllProjectMcpServers: true,
        },
        null,
        2,
      ),
    );
  }

  // Folder-trust and MCP-discovery dialogs are gated by per-project state in
  // ~/.claude.json (.projects[<abs_path>]). Pre-populate the entry for our
  // workspace so claude doesn't block startup waiting for human input.
  private async seedClaudeJson(): Promise<void> {
    const path = join(homedir(), ".claude.json");
    let cfg: any = {};
    try {
      cfg = JSON.parse(await readFile(path, "utf8"));
    } catch {
      /* fresh install — start empty */
    }
    cfg.projects ??= {};
    const existing = cfg.projects[config.workspace] ?? {};
    cfg.projects[config.workspace] = {
      allowedTools: [],
      mcpContextUris: [],
      mcpServers: {},
      disabledMcpjsonServers: [],
      hasClaudeMdExternalIncludesApproved: false,
      hasClaudeMdExternalIncludesWarningShown: false,
      projectOnboardingSeenCount: 1,
      ...existing,
      hasTrustDialogAccepted: true,
      enabledMcpjsonServers: Array.from(
        new Set([
          ...(existing.enabledMcpjsonServers ?? []),
          "outpost-channel",
        ]),
      ),
    };
    await writeFile(path, JSON.stringify(cfg, null, 2));
  }

  private spawn(): void {
    if (this.stopping) return;
    const claudeDir = config.claudeBin.includes("/")
      ? config.claudeBin.slice(0, config.claudeBin.lastIndexOf("/"))
      : null;
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      PATH: [claudeDir, process.env.PATH].filter(Boolean).join(":"),
      OUTPOST_SOCK: config.socketPath,
    };

    // PTY is required: claude detects non-TTY stdin/stdout as -p mode.
    // Bypass mode is configured through settings.local.json's
    // permissions.defaultMode so the warning dialog (which the CLI flag
    // triggers) doesn't block startup. Real auth is the bot allowlist.
    this.term = pty.spawn(
      config.claudeBin,
      [
        "--dangerously-load-development-channels",
        "server:outpost-channel",
      ],
      {
        name: "xterm-256color",
        cols: 200,
        rows: 50,
        cwd: config.workspace,
        env,
      },
    );

    console.log(`[supervisor] claude spawned pid=${this.term.pid}`);
    this.nextBackoff = RESTART_BACKOFF_MS;

    // Two startup dialogs fire after bypass mode + dev-channels are on:
    //   1. Bypass-mode warning — default cursor on option 1 ("No, exit"),
    //      so we Down+Enter to pick option 2 ("Yes, I accept").
    //   2. Dev-channels warning — default cursor on option 1 ("local
    //      development"), so a single Enter clears it.
    // Buffer chunks because ANSI escapes splice words and markers can
    // straddle chunk boundaries. PTY output is only mirrored to stderr when
    // OUTPOST_PTY_LOG is set; otherwise pm2 err.log stays readable.
    const ptyLog = !!process.env.OUTPOST_PTY_LOG;
    let outputBuffer = "";
    let bypassDismissed = false;
    let devChannelsDismissed = false;
    const sendSeq = (seq: string, label: string): void => {
      console.log(`[supervisor] ${label} warning detected, dismissing`);
      let tries = 0;
      const tick = (): void => {
        if (tries >= 3 || !this.term) return;
        tries++;
        this.term.write(seq);
        setTimeout(tick, 800);
      };
      setTimeout(tick, 1500);
    };
    this.term.onData((chunk) => {
      if (ptyLog) process.stderr.write(chunk);
      outputBuffer += chunk;
      if (outputBuffer.length > 8192) outputBuffer = outputBuffer.slice(-4096);
      if (
        !bypassDismissed &&
        outputBuffer.includes("code.claude.com/docs/en/security")
      ) {
        bypassDismissed = true;
        sendSeq("\x1b[B\r", "bypass-mode"); // Down + Enter → option 2
      }
      if (
        !devChannelsDismissed &&
        outputBuffer.includes("dangerously-load-development-channels")
      ) {
        devChannelsDismissed = true;
        sendSeq("\r", "dev-channels"); // Enter on default option 1
      }
    });

    this.term.onExit(({ exitCode, signal }) => {
      this.term = null;
      console.warn(
        `[supervisor] claude exited code=${exitCode} signal=${signal ?? "-"}`,
      );
      if (this.stopping) return;
      const wait = this.nextBackoff;
      this.nextBackoff = Math.min(this.nextBackoff * 2, RESTART_MAX_MS);
      setTimeout(() => this.spawn(), wait).unref();
    });
  }
}
