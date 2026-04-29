import * as pty from "node-pty";
import { config } from "./config.js";

// Strip CSI / OSC / single-char escape sequences so the buffer reads as plain text.
const ANSI_RE = /\x1b\[[\?\d;]*[a-zA-Z]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[\(\)].|\x1b[=>]/g;
export const stripAnsi = (s: string): string => s.replace(ANSI_RE, "");

export interface ClaudePty {
  send(text: string): void;
  close(): void;
  onData(handler: (raw: string, clean: string) => void): void;
  onExit(handler: (exitCode: number) => void): void;
}

export function spawnClaude(opts: { cwd?: string } = {}): ClaudePty {
  const term = pty.spawn(config.claudeBin, [], {
    name: "xterm-256color",
    cols: 120,
    rows: 30,
    cwd: opts.cwd ?? process.env.HOME ?? "/tmp",
    env: process.env as { [key: string]: string },
  });

  const dataHandlers: Array<(raw: string, clean: string) => void> = [];
  const exitHandlers: Array<(code: number) => void> = [];

  term.onData((chunk) => {
    const clean = stripAnsi(chunk);
    for (const h of dataHandlers) h(chunk, clean);
  });
  term.onExit(({ exitCode }) => {
    for (const h of exitHandlers) h(exitCode);
  });

  return {
    send: (t) => term.write(t),
    close: () => {
      try {
        term.kill();
      } catch {
        /* already dead */
      }
    },
    onData: (h) => {
      dataHandlers.push(h);
    },
    onExit: (h) => {
      exitHandlers.push(h);
    },
  };
}

const URL_RE = /https:\/\/[^\s\x1b\)\]"'`,;]+/g;

export interface AuthFlowOpts {
  onUrl: (url: string) => Promise<void> | void;
  timeoutMs?: number;
}

export interface AuthFlowResult {
  ok: boolean;
  error?: string;
  tail: string;
}

/**
 * Drive `claude` REPL through PTY, fire /login, harvest the OAuth URL, watch for completion markers.
 * The handler stays connected for up to `timeoutMs`; resolves when claude reports success/failure or REPL exits.
 */
export function loginFlow(opts: AuthFlowOpts): Promise<AuthFlowResult> {
  return new Promise((resolve) => {
    const term = spawnClaude();
    let cleanBuf = "";
    const seenUrls = new Set<string>();
    let resolved = false;

    const finish = (r: AuthFlowResult) => {
      if (resolved) return;
      resolved = true;
      term.close();
      resolve(r);
    };

    const timer = setTimeout(
      () =>
        finish({
          ok: false,
          error: "timeout (5 min)",
          tail: cleanBuf.slice(-500),
        }),
      opts.timeoutMs ?? 5 * 60_000,
    );
    timer.unref();

    // First-run / OAuth wizard navigation flags — each prompt we drive once.
    let themeAcked = false;
    let loginIssued = false;
    let methodAcked = false;

    // Claude pretty-prints with cursor positioning — strip whitespace before
    // matching so "Select login method" reads as "selectloginmethod" reliably.
    const norm = (s: string): string => s.replace(/\s+/g, "").toLowerCase();

    term.onData((_raw, clean) => {
      cleanBuf += clean;
      const recent = cleanBuf.slice(-4000);
      const recentNorm = norm(recent);

      // First-run theme picker → press Enter to accept Dark default.
      if (!themeAcked && /choosethetextstyle/.test(recentNorm)) {
        themeAcked = true;
        setTimeout(() => term.send("\r"), 700);
      }

      // OAuth method picker after /login → press Enter for subscription default.
      if (loginIssued && !methodAcked && /selectloginmethod/.test(recentNorm)) {
        methodAcked = true;
        setTimeout(() => term.send("\r"), 700);
      }

      for (const m of clean.matchAll(URL_RE)) {
        const url = m[0];
        if (
          (url.includes("claude.ai") || url.includes("anthropic.com")) &&
          !seenUrls.has(url)
        ) {
          seenUrls.add(url);
          Promise.resolve(opts.onUrl(url)).catch(() => {});
        }
      }

      if (
        /successfully(loggedin|authenticated)|already(loggedin|authorized)/.test(
          recentNorm,
        )
      ) {
        clearTimeout(timer);
        finish({ ok: true, tail: recent.slice(-500) });
      }
      if (/(authentication|login)(failed|cancel(led)?)/.test(recentNorm)) {
        clearTimeout(timer);
        finish({ ok: false, error: "auth failed", tail: recent.slice(-500) });
      }
    });

    term.onExit((code) => {
      clearTimeout(timer);
      finish({
        ok: code === 0,
        error: code !== 0 ? `exit ${code}` : undefined,
        tail: cleanBuf.slice(-500),
      });
    });

    // First-run wizard may delay REPL; wait a bit longer than before.
    setTimeout(() => {
      loginIssued = true;
      term.send("/login\r");
    }, 5000);
  });
}
