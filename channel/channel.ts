#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { connect, type Socket } from "node:net";

const SOCK = process.env.OUTPOST_SOCK ?? "/run/outpost.sock";
const VERSION = "0.1.0";

interface Ack {
  ok: boolean;
  error?: string;
}

let pendingAck: { resolve: (a: Ack) => void; reject: (e: Error) => void } | null = null;
let sockReady = false;

const sock: Socket = connect(SOCK);
let buf = "";

sock.on("connect", () => {
  sockReady = true;
  sock.write(
    JSON.stringify({
      type: "hello",
      protocol: "v0",
      channel_version: VERSION,
      pid: process.pid,
    }) + "\n",
  );
});

sock.on("data", (chunk: Buffer) => {
  buf += chunk.toString("utf8");
  let idx: number;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch (err) {
      console.error(`[channel] bad json: ${err}`);
      continue;
    }
    if (msg.type === "inbound") {
      void mcp.notification({
        method: "notifications/claude/channel",
        params: { content: msg.content, meta: msg.meta },
      });
    } else if (msg.type === "ack") {
      pendingAck?.resolve({ ok: !!msg.ok, error: msg.error });
      pendingAck = null;
    } else {
      console.error(`[channel] unknown msg type: ${msg.type}`);
    }
  }
});

sock.on("error", (err) => {
  console.error(`[channel] socket error: ${err.message}`);
  sockReady = false;
  pendingAck?.reject(err);
  pendingAck = null;
});

sock.on("close", () => {
  sockReady = false;
  pendingAck?.reject(new Error("socket closed"));
  pendingAck = null;
});

const mcp = new Server(
  { name: "outpost-channel", version: VERSION },
  {
    capabilities: { experimental: { "claude/channel": {} }, tools: {} },
    instructions: [
      'Inbound messages arrive as <channel source="outpost-channel" chat_id="...">.',
      "",
      "The user is on a remote chat client. They cannot see your terminal output, your reasoning, your tool calls, or any free-form text you write. The ONLY thing they see is what you send through the `reply` MCP tool. A turn that ends without a `reply` call is invisible — they get silence, no matter how much you wrote.",
      "",
      "Therefore: every inbound from this channel must end with a `reply` tool call carrying the same `chat_id` from the inbound tag. If you need to think out loud, fine, but the conclusion goes in `reply`. Long answer? Put the long answer in `reply.text`. Quick acknowledgement? Still call `reply`. No-op turn? Call `reply` with a short status. Never end a turn from this channel with only free text — the user will think you ignored them.",
    ].join("\n"),
  },
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description: "Send a text message back to the channel's chat. Pass the chat_id from the inbound tag.",
      inputSchema: {
        type: "object",
        properties: {
          chat_id: { type: "string" },
          text: { type: "string" },
        },
        required: ["chat_id", "text"],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== "reply") {
    throw new Error(`unknown tool: ${req.params.name}`);
  }
  const { chat_id, text } = req.params.arguments as {
    chat_id: string;
    text: string;
  };
  if (!sockReady) {
    return { content: [{ type: "text", text: "failed: daemon socket not connected" }] };
  }
  if (pendingAck) {
    return { content: [{ type: "text", text: "failed: another reply still in flight" }] };
  }
  const ack = await new Promise<Ack>((resolve, reject) => {
    pendingAck = { resolve, reject };
    sock.write(JSON.stringify({ type: "reply", chat_id, text }) + "\n");
  }).catch((err) => ({ ok: false, error: String(err.message ?? err) }) as Ack);
  return {
    content: [{ type: "text", text: ack.ok ? "sent" : `failed: ${ack.error ?? "unknown"}` }],
  };
});

await mcp.connect(new StdioServerTransport());
console.error(`[channel] connected to claude over stdio, daemon=${SOCK}`);
