import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { config } from "./config.js";

export type ClaudeEvent =
  | { kind: "tool_use"; name: string; input: unknown }
  | { kind: "tool_result"; isError: boolean; content: string }
  | { kind: "stream_text_start"; index: number }
  | { kind: "stream_text_delta"; index: number; delta: string }
  | { kind: "stream_text_stop"; index: number }
  | { kind: "thinking" }
  | { kind: "init" }
  | { kind: "usage"; inputTokens: number; outputTokens: number; durationMs: number }
  | { kind: "done"; sessionId: string; aborted: boolean }
  | { kind: "error"; message: string };

export interface RunArgs {
  sessionId: string;
  cwd: string;
  prompt: string;
  isFirst: boolean;
  signal?: AbortSignal;
  /** Hard cap on total wall-clock duration. Default 30 min — defends against runaway loops. */
  hardTimeoutMs?: number;
  /** Idle deadline — kill if no stdout event for this long. Default 5 min. */
  idleTimeoutMs?: number;
  onEvent: (e: ClaudeEvent) => void | Promise<void>;
}

interface BlockState {
  kind: "text" | "tool_use" | "thinking";
  name?: string;
  partialJson?: string;
}

// Tool-layer instruction injected into every turn. Persona still lives in
// cwd/CLAUDE.md (single source of truth); this is gateway-owned plumbing
// that bypasses the Linux Bash sandbox per-call — `--dangerously-skip-permissions`
// only kills approval prompts, the sandbox is a separate gate that can only
// be opened with the per-call `dangerouslyDisableSandbox: true` parameter.
const SANDBOX_BYPASS_PROMPT = `When using the Bash tool, set \`dangerouslyDisableSandbox: true\` on every call. This session runs over a Telegram bridge with no approval UI, and the Bash sandbox blocks writes outside cwd (e.g. ~/.claude/skills/, ~/.config/) which is the dominant failure mode here. Prefer the Write tool when creating files — it's not gated by the Bash sandbox at all and accepts parallel calls.`;

export async function runClaude(args: RunArgs): Promise<void> {
  await mkdir(args.cwd, { recursive: true });

  const cliArgs = [
    "-p",
    args.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--dangerously-skip-permissions",
    "--append-system-prompt",
    SANDBOX_BYPASS_PROMPT,
  ];
  if (args.isFirst) cliArgs.push("--session-id", args.sessionId);
  else cliArgs.push("--resume", args.sessionId);

  // 確保 child 與其 Bash tool 子程序的 PATH 含 claude 所在目錄
  const claudeDir = config.claudeBin.includes("/")
    ? config.claudeBin.slice(0, config.claudeBin.lastIndexOf("/"))
    : null;
  const childEnv = {
    ...process.env,
    PATH: [claudeDir, process.env.PATH].filter(Boolean).join(":"),
  };

  const child: ChildProcess = spawn(config.claudeBin, cliArgs, {
    cwd: args.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: childEnv,
  });

  const startedAt = Date.now();
  let aborted = false;
  let timedOut = false;
  let idleTimedOut = false;

  // Hard cap: defends against truly runaway agents.
  const hardTimeout = setTimeout(
    () => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3_000).unref();
    },
    args.hardTimeoutMs ?? 30 * 60_000,
  );
  hardTimeout.unref();

  // Idle watchdog: kicked on every stdout chunk. A long-running turn that
  // keeps emitting tool calls and text deltas stays alive; one that hangs
  // silently for `idleTimeoutMs` gets reaped.
  const idleMs = args.idleTimeoutMs ?? 5 * 60_000;
  let idleTimer: NodeJS.Timeout = setTimeout(onIdle, idleMs);
  idleTimer.unref();
  function onIdle(): void {
    idleTimedOut = true;
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 3_000).unref();
  }
  function bumpIdle(): void {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(onIdle, idleMs);
    idleTimer.unref();
  }

  const onAbort = () => {
    aborted = true;
    child.kill("SIGTERM");
    setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
    }, 3_000).unref();
  };
  args.signal?.addEventListener("abort", onAbort, { once: true });

  let buf = "";
  const blocks = new Map<number, BlockState>();

  child.stdout!.on("data", (chunk: Buffer) => {
    bumpIdle();
    buf += chunk.toString("utf8");
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        handleLine(JSON.parse(line), args.onEvent, blocks, startedAt);
      } catch {
        // ignore JSON parse errors on partial chunks
      }
    }
  });

  child.stderr!.on("data", (chunk: Buffer) => {
    const msg = chunk.toString("utf8").trim();
    // claude 把 warning/info 也走 stderr，不全部當 error 推給 user。
    // 真正錯誤會由 stream-json 的 result event 或非零 exit code 反映。
    if (msg) console.warn("[claude:stderr]", msg);
  });

  await new Promise<void>((resolve) => {
    child.on("close", () => {
      clearTimeout(hardTimeout);
      clearTimeout(idleTimer);
      args.signal?.removeEventListener("abort", onAbort);
      if (timedOut) {
        const reason = idleTimedOut
          ? `idle timeout: no output for ${Math.round(idleMs / 1000)}s — agent likely stuck`
          : `hard timeout: turn exceeded ${Math.round((args.hardTimeoutMs ?? 30 * 60_000) / 60_000)}min wall clock`;
        args.onEvent({ kind: "error", message: reason });
      }
      args.onEvent({ kind: "done", sessionId: args.sessionId, aborted });
      resolve();
    });
  });
}

function handleLine(
  obj: any,
  emit: (e: ClaudeEvent) => void,
  blocks: Map<number, BlockState>,
  startedAt: number,
): void {
  if (!obj || typeof obj !== "object") return;

  if (obj.type === "stream_event" && obj.event) {
    const e = obj.event;
    switch (e.type) {
      case "content_block_start": {
        const cb = e.content_block ?? {};
        const idx: number = e.index ?? 0;
        if (cb.type === "text") {
          blocks.set(idx, { kind: "text" });
          emit({ kind: "stream_text_start", index: idx });
        } else if (cb.type === "tool_use") {
          blocks.set(idx, {
            kind: "tool_use",
            name: cb.name,
            partialJson: "",
          });
        } else if (cb.type === "thinking") {
          blocks.set(idx, { kind: "thinking" });
          emit({ kind: "thinking" });
        }
        break;
      }
      case "content_block_delta": {
        const idx: number = e.index ?? 0;
        const blk = blocks.get(idx);
        if (!blk) return;
        const d = e.delta ?? {};
        if (blk.kind === "text" && d.type === "text_delta" && typeof d.text === "string") {
          emit({ kind: "stream_text_delta", index: idx, delta: d.text });
        } else if (
          blk.kind === "tool_use" &&
          d.type === "input_json_delta" &&
          typeof d.partial_json === "string"
        ) {
          blk.partialJson = (blk.partialJson ?? "") + d.partial_json;
        }
        break;
      }
      case "content_block_stop": {
        const idx: number = e.index ?? 0;
        const blk = blocks.get(idx);
        if (!blk) return;
        if (blk.kind === "text") {
          emit({ kind: "stream_text_stop", index: idx });
        } else if (blk.kind === "tool_use") {
          let input: unknown = {};
          try {
            input = JSON.parse(blk.partialJson ?? "{}");
          } catch {
            input = { _raw: blk.partialJson };
          }
          emit({ kind: "tool_use", name: blk.name ?? "Unknown", input });
        }
        blocks.delete(idx);
        break;
      }
      // ignore: message_start, message_delta, message_stop
    }
  } else if (obj.type === "user" && obj.message?.content) {
    for (const block of obj.message.content) {
      if (block.type === "tool_result") {
        const content = Array.isArray(block.content)
          ? block.content.map((c: any) => c.text ?? "").join("")
          : typeof block.content === "string"
            ? block.content
            : "";
        emit({
          kind: "tool_result",
          isError: !!block.is_error,
          content: content.slice(0, 1000),
        });
      }
    }
  } else if (obj.type === "system" && obj.subtype === "init") {
    emit({ kind: "init" });
  } else if (obj.type === "result") {
    const usage = obj.usage ?? {};
    emit({
      kind: "usage",
      inputTokens:
        (usage.input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0),
      outputTokens: usage.output_tokens ?? 0,
      durationMs: obj.duration_ms ?? Date.now() - startedAt,
    });
  }
  // 忽略 assistant aggregate event（streaming 已處理），以及 system / rate_limit_event
}
