import type { Context } from "grammy";
import { runClaude, type ClaudeEvent } from "./claude.js";
import * as ses from "./session.js";
import r from "./personas/index.js";

export const TURN_TIMEOUT_MS = 10 * 60_000;
const TELEGRAM_EDIT_THROTTLE_MS = 500;
export const MAX_PROMPT_BYTES = 32 * 1024;

interface SegState {
  msgId: number | null;
  text: string;
  lastEditAt: number;
  pendingEdit: NodeJS.Timeout | null;
}

type Replier = (text: string) => Promise<void>;

export async function runTurn(
  ctx: Context,
  prompt: string,
  reply: Replier,
): Promise<void> {
  const uid = ctx.from!.id;
  const active = ses.activeSession(uid);
  if (!active) return reply(r.noActive());

  if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) {
    return reply(
      r.toolFail(
        `prompt 太長（${Buffer.byteLength(prompt, "utf8")} bytes，上限 ${MAX_PROMPT_BYTES}）`,
      ),
    );
  }

  if (ses.isBusy(active.id)) return reply(r.busy());

  const isFirst = !active.initialized;
  ses.bumpTurn(uid);
  const turnStart = Date.now();

  const ac = new AbortController();
  ses.setBusy(active.id, ac);
  await ctx.replyWithChatAction("typing").catch(() => {});

  const segs = new Map<number, SegState>();

  const flushSeg = async (idx: number, force: boolean): Promise<void> => {
    const seg = segs.get(idx);
    if (!seg || seg.msgId === null) return;
    if (seg.pendingEdit) {
      clearTimeout(seg.pendingEdit);
      seg.pendingEdit = null;
    }
    seg.lastEditAt = Date.now();
    const html = force
      ? r.finalAnswer(seg.text || "…")
      : r.md.esc(seg.text || "…") + " ▍";
    try {
      await ctx.api.editMessageText(ctx.chat!.id, seg.msgId, html, {
        parse_mode: "HTML",
      });
    } catch (err: any) {
      const desc = String(err?.description ?? "");
      if (desc.includes("not modified")) return;
      try {
        await ctx.api.editMessageText(ctx.chat!.id, seg.msgId, seg.text);
      } catch {}
    }
  };

  const scheduleEdit = (idx: number): void => {
    const seg = segs.get(idx);
    if (!seg) return;
    const elapsed = Date.now() - seg.lastEditAt;
    if (elapsed >= TELEGRAM_EDIT_THROTTLE_MS) {
      void flushSeg(idx, false);
      return;
    }
    if (!seg.pendingEdit) {
      seg.pendingEdit = setTimeout(
        () => void flushSeg(idx, false),
        TELEGRAM_EDIT_THROTTLE_MS - elapsed,
      );
    }
  };

  const onEvent = async (e: ClaudeEvent) => {
    switch (e.kind) {
      case "init":
        // Claude 端確認 session-id；下一輪以後 isFirst=false
        ses.markInitialized(active.id);
        break;
      case "tool_use":
        await reply(r.toolCall(e.name, e.input));
        break;
      case "tool_result":
        if (e.isError) await reply(r.toolFail(e.content));
        break;
      case "stream_text_start": {
        let msgId: number | null = null;
        try {
          const m = await ctx.reply("…", { parse_mode: "HTML" });
          msgId = m.message_id;
        } catch {}
        segs.set(e.index, {
          msgId,
          text: "",
          lastEditAt: 0,
          pendingEdit: null,
        });
        break;
      }
      case "stream_text_delta": {
        const seg = segs.get(e.index);
        if (!seg) break;
        seg.text += e.delta;
        scheduleEdit(e.index);
        break;
      }
      case "stream_text_stop": {
        const seg = segs.get(e.index);
        if (!seg) break;
        if (!seg.text && seg.msgId !== null) {
          await ctx.api
            .deleteMessage(ctx.chat!.id, seg.msgId)
            .catch(() => {});
        } else {
          await flushSeg(e.index, true);
        }
        segs.delete(e.index);
        break;
      }
      case "thinking":
        break;
      case "usage":
        ses.addUsage(uid, e.inputTokens, e.outputTokens);
        await reply(r.turnComplete(e));
        break;
      case "error":
        await reply(r.toolFail(e.message));
        break;
      case "done":
        for (const idx of segs.keys()) await flushSeg(idx, true);
        segs.clear();
        break;
    }
    if (
      e.kind !== "done" &&
      e.kind !== "usage" &&
      e.kind !== "stream_text_delta"
    ) {
      await ctx.replyWithChatAction("typing").catch(() => {});
    }
  };

  try {
    await runClaude({
      sessionId: active.id,
      cwd: active.cwd,
      prompt,
      isFirst,
      systemPrompt: r.systemPrompt,
      description: active.description,
      signal: ac.signal,
      timeoutMs: TURN_TIMEOUT_MS,
      onEvent,
    });
  } catch (err: any) {
    await reply(r.toolFail(String(err?.message ?? err)));
  } finally {
    ses.clearBusy(active.id);
  }
}
