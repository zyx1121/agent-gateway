import * as pty from "node-pty";
import { writeFileSync } from "node:fs";
import { config } from "./config.js";

// Debug trace dropped to /tmp on every loginFlow finish so we can autopsy
// failures without re-running the OAuth song-and-dance.
const traceLog = (path: string, body: string): void => {
  try {
    writeFileSync(path, body);
  } catch {
    /* ignore */
  }
};

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
    // Wide cols so long OAuth URLs aren't soft-wrapped (which inserts
    // \r\n into the URL and defeats the URL regex).
    cols: 2000,
    rows: 50,
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
  // After OAuth in browser, claude prompts for the authorization code.
  // Resolve with the code string; loginFlow forwards it to the REPL.
  onCodePrompt?: () => Promise<string> | string;
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
    const startedAt = Date.now();
    const events: string[] = [`[${Date.now()}] spawn claude`];
    let cleanBuf = "";
    let rawBuf = "";
    const seenUrls = new Set<string>();
    let resolved = false;

    const finish = (r: AuthFlowResult) => {
      if (resolved) return;
      resolved = true;
      events.push(`[${Date.now()}] finish ok=${r.ok} err=${r.error ?? ""}`);
      const path = `/tmp/pty-login-${startedAt}.log`;
      const dump = [
        "=== events ===",
        events.join("\n"),
        "",
        "=== raw last 8000 ===",
        rawBuf.slice(-8000),
        "",
        "=== clean last 8000 ===",
        cleanBuf.slice(-8000),
      ].join("\n");
      traceLog(path, dump);
      console.log(`[loginFlow] ok=${r.ok} trace=${path}`);
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
    let codePromptHandled = false;

    // Claude pretty-prints with cursor positioning — strip whitespace before
    // matching so "Select login method" reads as "selectloginmethod" reliably.
    const norm = (s: string): string => s.replace(/\s+/g, "").toLowerCase();

    term.onData((raw, clean) => {
      cleanBuf += clean;
      rawBuf += raw;
      const recent = cleanBuf.slice(-4000);
      const recentNorm = norm(recent);

      if (!themeAcked && /choosethetextstyle/.test(recentNorm)) {
        themeAcked = true;
        events.push(`[${Date.now()}] theme picker → enter`);
        setTimeout(() => term.send("\r"), 700);
      }

      if (loginIssued && !methodAcked && /selectloginmethod/.test(recentNorm)) {
        methodAcked = true;
        events.push(`[${Date.now()}] method picker → enter`);
        setTimeout(() => term.send("\r"), 700);
      }

      if (
        loginIssued &&
        !codePromptHandled &&
        opts.onCodePrompt &&
        /paste.{0,60}(code|here)/.test(recentNorm)
      ) {
        codePromptHandled = true;
        events.push(`[${Date.now()}] paste prompt detected → onCodePrompt`);
        Promise.resolve(opts.onCodePrompt())
          .then((code) => {
            const trimmed = (code ?? "").trim();
            events.push(
              `[${Date.now()}] code received len=${trimmed.length} ` +
                `head=${JSON.stringify(trimmed.slice(0, 8))} ` +
                `tail=${JSON.stringify(trimmed.slice(-8))}`,
            );
            if (trimmed) {
              term.send(trimmed + "\r");
              events.push(`[${Date.now()}] term.send(code + \\r)`);
            }
          })
          .catch((err) => {
            events.push(`[${Date.now()}] onCodePrompt rejected: ${err}`);
          });
      }

      // Match against cumulative buffer — a long URL may arrive split across
      // PTY chunks. Host list covers current and legacy claude OAuth domains.
      for (const m of cleanBuf.matchAll(URL_RE)) {
        const url = m[0];
        if (
          (url.includes("claude.ai") ||
            url.includes("claude.com") ||
            url.includes("anthropic.com")) &&
          !seenUrls.has(url)
        ) {
          seenUrls.add(url);
          events.push(`[${Date.now()}] URL: ${url.slice(0, 80)}…`);
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
      events.push(`[${Date.now()}] send /login`);
      term.send("/login\r");
    }, 5000);
  });
}
