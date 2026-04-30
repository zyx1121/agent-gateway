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
  | { kind: "init"; skills: string[]; mcpServers: { name: string; status: string }[] }
  | { kind: "usage"; inputTokens: number; outputTokens: number; durationMs: number }
  | { kind: "done"; sessionId: string; aborted: boolean }
  | { kind: "error"; message: string };

export interface RunArgs {
  sessionId: string;
  cwd: string;
  prompt: string;
  isFirst: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  onEvent: (e: ClaudeEvent) => void | Promise<void>;
}

interface BlockState {
  kind: "text" | "tool_use" | "thinking";
  name?: string;
  partialJson?: string;
}

// 快速 probe：跑一個極小的 claude -p，攔到 system init line 就 kill。
// 用於 /skills /mcp 之類即時查詢。
const INIT_TTL_MS = 30_000;
let initCache: {
  data: { skills: string[]; mcpServers: { name: string; status: string }[] };
  at: number;
} | null = null;

export async function probeInit(): Promise<{
  skills: string[];
  mcpServers: { name: string; status: string }[];
}> {
  if (initCache && Date.now() - initCache.at < INIT_TTL_MS) {
    return initCache.data;
  }
  const data = await actualProbeInit();
  initCache = { data, at: Date.now() };
  return data;
}

async function actualProbeInit(): Promise<{
  skills: string[];
  mcpServers: { name: string; status: string }[];
}> {
  const claudeDir = config.claudeBin.includes("/")
    ? config.claudeBin.slice(0, config.claudeBin.lastIndexOf("/"))
    : null;
  const env = {
    ...process.env,
    PATH: [claudeDir, process.env.PATH].filter(Boolean).join(":"),
  };
  return new Promise((resolve) => {
    const child = spawn(
      config.claudeBin,
      [
        "-p",
        ".",
        "--output-format",
        "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
      ],
      { stdio: ["ignore", "pipe", "ignore"], env },
    );
    let buf = "";
    let resolved = false;
    const finish = (data: ReturnType<typeof empty>) => {
      if (resolved) return;
      resolved = true;
      child.kill("SIGKILL");
      resolve(data);
    };
    const timer = setTimeout(() => finish(empty()), 8000);
    timer.unref();
    child.stdout!.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.type === "system" && obj.subtype === "init") {
            clearTimeout(timer);
            finish({
              skills: Array.isArray(obj.skills) ? obj.skills : [],
              mcpServers: Array.isArray(obj.mcp_servers)
                ? obj.mcp_servers.map((m: any) => ({
                    name: m.name,
                    status: m.status,
                  }))
                : [],
            });
            return;
          }
        } catch {}
      }
    });
    child.on("close", () => finish(empty()));
  });
}

const empty = () => ({ skills: [] as string[], mcpServers: [] as { name: string; status: string }[] });

export async function runClaude(args: RunArgs): Promise<void> {
  await mkdir(args.cwd, { recursive: true });

  // No --append-system-prompt: agent persona lives in cwd/CLAUDE.md, which
  // Claude Code reads natively. Single source of truth, ssh-editable, no
  // double-injection drift.
  const cliArgs = [
    "-p",
    args.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--dangerously-skip-permissions",
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

  const timeout = setTimeout(
    () => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3_000).unref();
    },
    args.timeoutMs ?? 10 * 60_000,
  );
  timeout.unref();

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
      clearTimeout(timeout);
      args.signal?.removeEventListener("abort", onAbort);
      if (timedOut) {
        args.onEvent({ kind: "error", message: "timeout: agent took too long" });
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
    emit({
      kind: "init",
      skills: Array.isArray(obj.skills) ? obj.skills : [],
      mcpServers: Array.isArray(obj.mcp_servers)
        ? obj.mcp_servers.map((m: any) => ({
            name: m.name,
            status: m.status,
          }))
        : [],
    });
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

export interface UsageBar {
  label: string;
  percent: number | null;
  resetsAt: string | null;
}

// 跑原生 claude TUI 攔 /usage 渲染輸出 → parse 出三條 bar 數值
const USAGE_TTL_MS = 60_000;
let usageCache: { data: UsageBar[]; at: number } | null = null;

export async function probeUsage(): Promise<UsageBar[]> {
  if (usageCache && Date.now() - usageCache.at < USAGE_TTL_MS) {
    return usageCache.data;
  }
  const data = await actualProbeUsage();
  usageCache = { data, at: Date.now() };
  return data;
}

async function actualProbeUsage(): Promise<UsageBar[]> {
  const claudeDir = config.claudeBin.includes("/")
    ? config.claudeBin.slice(0, config.claudeBin.lastIndexOf("/"))
    : null;
  const env = {
    ...process.env,
    PATH: [claudeDir, process.env.PATH].filter(Boolean).join(":"),
  };
  const script = `
set timeout 15
log_user 1
spawn -noecho ${config.claudeBin}
sleep 2
send "1\\r"
sleep 2
send "/usage\\r"
sleep 5
send "\\003"
expect eof
`;
  const child = spawn("expect", ["-c", script], {
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
  let out = "";
  child.stdout!.on("data", (c: Buffer) => {
    out += c.toString("utf8");
  });
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 20_000);
    t.unref();
    child.on("close", () => {
      clearTimeout(t);
      resolve();
    });
  });
  return parseUsageOutput(out);
}

function parseUsageOutput(raw: string): UsageBar[] {
  const text = raw
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\r/g, "")
    .replace(/\s+/g, " ");

  const labels = [
    { key: "session", regex: /Current\s*session/i, label: "Current session" },
    {
      key: "week-all",
      regex: /Current\s*week\s*\(\s*all\s*models?\s*\)/i,
      label: "Current week (all models)",
    },
    {
      key: "week-sonnet",
      regex: /Current\s*week\s*\(\s*Sonnet\s*only\s*\)/i,
      label: "Current week (Sonnet only)",
    },
  ];

  const bars: UsageBar[] = [];
  for (let i = 0; i < labels.length; i++) {
    const cur = labels[i];
    const m = cur.regex.exec(text);
    if (!m) {
      bars.push({ label: cur.label, percent: null, resetsAt: null });
      continue;
    }
    const startIdx = m.index;
    const next = labels[i + 1];
    const endIdx = next?.regex.exec(text)?.index ?? startIdx + 200;
    const slice = text.slice(startIdx, endIdx);
    const pctMatch = /(\d+)\s*%\s*used/i.exec(slice);
    const resetMatch = /Resets\s+([^|]+?)(?=Current|$)/i.exec(slice);
    bars.push({
      label: cur.label,
      percent: pctMatch ? Number(pctMatch[1]) : null,
      resetsAt: resetMatch ? resetMatch[1].trim().replace(/\s+/g, " ") : null,
    });
  }
  return bars;
}
