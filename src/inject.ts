// Client-side CLI for `outpost inject` — connects to the daemon's socket,
// sends a one-shot system_inject, waits for ack, exits.
//
// Used by cron / sidecar processes that need to deliver a synthetic inbound
// to the long-running claude session (e.g. quant's post-close trigger).

import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

interface InjectArgs {
  message: string;
  chatId: string;
  user: string;
  source: string;
  socketPath: string;
  timeoutMs: number;
}

interface InjectAck {
  type: "ack";
  for: string;
  ok: boolean;
  delivered?: boolean;
  error?: string;
}

const HELP = `outpost inject — send a synthetic inbound to the daemon's claude session.

Usage:
  outpost inject [options] <message>
  echo "msg" | outpost inject [options] -

Options:
  --chat-id <id>     meta.chat_id (default: system:outpost-cli)
  --user <name>      meta.user    (default: cli)
  --source <name>    meta.source  (default: outpost-inject)
  --socket <path>    socket path  (default: $OUTPOST_SOCK or ~/outpost.sock)
  --timeout <ms>     ack timeout  (default: 5000)
  -h, --help         show this help

Examples:
  outpost inject "ping"
  outpost inject --source quant-cron "[scheduled] post-close"
  echo "long message body" | outpost inject -

Exit codes:
  0  delivered (or buffered, if channel briefly disconnected)
  1  daemon unreachable or other error
  2  bad CLI args

The daemon buffers up to 16 pending inbounds while no channel is attached;
buffered messages are flushed when the channel reconnects.
`;

function parseArgs(argv: string[]): InjectArgs | { help: true } | { error: string } {
  let message: string | null = null;
  let chatId = "system:outpost-cli";
  let user = "cli";
  let source = "outpost-inject";
  const socketPath =
    process.env.OUTPOST_SOCK ?? join(homedir(), "outpost.sock");
  let resolvedSocket = socketPath;
  let timeoutMs = 5_000;

  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    switch (a) {
      case "-h":
      case "--help":
        return { help: true };
      case "--chat-id":
        chatId = argv[++i] ?? "";
        break;
      case "--user":
        user = argv[++i] ?? "";
        break;
      case "--source":
        source = argv[++i] ?? "";
        break;
      case "--socket":
        resolvedSocket = argv[++i] ?? resolvedSocket;
        break;
      case "--timeout":
        timeoutMs = Number(argv[++i] ?? timeoutMs);
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
          return { error: "--timeout must be a positive number" };
        }
        break;
      default:
        if (a.startsWith("-") && a !== "-") {
          return { error: `unknown flag: ${a}` };
        }
        if (message !== null) {
          return { error: `unexpected positional arg: ${a}` };
        }
        message = a;
    }
    i++;
  }
  if (message === null) return { error: "message required (or '-' for stdin)" };
  return { message, chatId, user, source, socketPath: resolvedSocket, timeoutMs };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8").trim();
}

async function injectOne(args: InjectArgs): Promise<{ ok: boolean; ack?: InjectAck; error?: string }> {
  const payload = {
    type: "system_inject",
    content: args.message,
    meta: {
      chat_id: args.chatId,
      user: args.user,
      source: args.source,
      ts: new Date().toISOString(),
    },
  };
  return new Promise((resolve) => {
    const conn = connect(args.socketPath);
    const timer = setTimeout(() => {
      conn.destroy();
      resolve({ ok: false, error: `timeout waiting for ack (${args.timeoutMs}ms)` });
    }, args.timeoutMs);

    let buf = "";
    let settled = false;
    const settle = (r: { ok: boolean; ack?: InjectAck; error?: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.destroy();
      resolve(r);
    };

    conn.on("connect", () => {
      conn.write(JSON.stringify(payload) + "\n");
    });
    conn.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf-8");
      const idx = buf.indexOf("\n");
      if (idx < 0) return;
      const line = buf.slice(0, idx);
      try {
        const ack: InjectAck = JSON.parse(line);
        settle({ ok: ack.ok === true, ack });
      } catch (e: any) {
        settle({ ok: false, error: `bad ack json: ${e?.message ?? e}` });
      }
    });
    conn.on("error", (err: Error) => {
      settle({ ok: false, error: err.message });
    });
    conn.on("close", () => {
      settle({ ok: false, error: "socket closed before ack" });
    });
  });
}

export async function runInjectCli(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if ("help" in parsed) {
    process.stdout.write(HELP);
    return 0;
  }
  if ("error" in parsed) {
    process.stderr.write(`outpost inject: ${parsed.error}\n\n${HELP}`);
    return 2;
  }
  if (parsed.message === "-") {
    parsed.message = await readStdin();
    if (!parsed.message) {
      process.stderr.write("outpost inject: stdin was empty\n");
      return 2;
    }
  }
  const result = await injectOne(parsed);
  if (result.ok) {
    const delivered = result.ack?.delivered === true;
    process.stdout.write(
      delivered ? "sent (delivered to channel)\n" : "sent (buffered — no active channel)\n",
    );
    return 0;
  }
  process.stderr.write(`inject failed: ${result.error ?? result.ack?.error ?? "unknown"}\n`);
  return 1;
}
