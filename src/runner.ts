import type { DaemonSocket } from "./socket.js";

export const MAX_PROMPT_BYTES = 32 * 1024;

export interface InboundMeta {
  chat_id: string;
  user?: string;
  ts?: string;
  [k: string]: string | undefined;
}

export function dispatchInbound(
  sock: DaemonSocket,
  content: string,
  meta: InboundMeta,
): { ok: boolean; error?: string } {
  if (Buffer.byteLength(content, "utf8") > MAX_PROMPT_BYTES) {
    return {
      ok: false,
      error: `prompt too large (${Buffer.byteLength(content, "utf8")} bytes, max ${MAX_PROMPT_BYTES})`,
    };
  }
  // Keys must match [a-z][a-z0-9_]* on the claude side — drop anything
  // that wouldn't survive the round trip rather than send garbage.
  const cleanMeta: Record<string, string> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (v === undefined) continue;
    if (!/^[a-z][a-z0-9_]*$/.test(k)) continue;
    cleanMeta[k] = String(v);
  }
  sock.send({ type: "inbound", content, meta: cleanMeta });
  return { ok: true };
}
