import type { Context } from "grammy";
import { runClaude, type ClaudeEvent } from "./claude.js";
import * as ses from "./session.js";
import { logTurn } from "./turnlog.js";
import * as msg from "./messages.js";

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
  if (!active) return reply(msg.noActive());

  if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) {
    return reply(
      msg.toolFail(
        `prompt too large (${Buffer.byteLength(prompt, "utf8")} bytes, max ${MAX_PROMPT_BYTES})`,
      ),
    );
  }

  if (ses.isBusy(active.id)) return reply(msg.busy());

  const isFirst = !active.initialized;
  ses.bumpTurn(uid);
  const turnStart = Date.now();

  const ac = new AbortController();
  ses.setBusy(active.id, ac);
  await ctx.replyWithChatAction("typing").catch(() => {});

  const chatId = ctx.chat?.id ?? 0;
  void logTurn({
    ts: turnStart,
    chatId,
    userId: uid,
    sessionId: active.id,
    kind: "start",
    prompt,
  });

  const segs = new Map<number, SegState>();

  const flushSeg = async (idx: number, force: boolean): Promise<void> => {
    const seg = segs.get(idx);
    if (!seg) return;
    // Placeholder reply hasn't returned yet. On force=true (final flush) we
    // fall back to a fresh reply so the answer never gets lost; on the
    // streaming path we just defer until the next tick.
    if (seg.msgId === null) {
      if (!force) return;
      if (seg.text) await reply(msg.finalAnswer(seg.text));
      return;
    }
    if (seg.pendingEdit) {
      clearTimeout(seg.pendingEdit);
      seg.pendingEdit = null;
    }
    seg.lastEditAt = Date.now();
    const html = force
      ? msg.finalAnswer(seg.text || "…")
      : msg.md.esc(seg.text || "…") + " _";
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
        // Claude side acknowledged the session-id; subsequent turns resume.
        ses.markInitialized(active.id);
        break;
      case "tool_use":
        await reply(msg.toolCall(e.name, e.input));
        void logTurn({
          ts: Date.now(),
          chatId,
          userId: uid,
          sessionId: active.id,
          kind: "tool",
          toolName: e.name,
          toolInput: e.input,
        });
        break;
      case "tool_result":
        if (e.isError) await reply(msg.toolFail(e.content));
        break;
      case "stream_text_start": {
        // Set the seg synchronously BEFORE awaiting telegram so a delta that
        // arrives mid-await still finds an entry to append to. msgId is
        // filled in once the placeholder reply comes back; flushSeg is a
        // no-op while it's null and will retry on the next throttle tick.
        segs.set(e.index, {
          msgId: null,
          text: "",
          lastEditAt: 0,
          pendingEdit: null,
        });
        ctx
          .reply("…", { parse_mode: "HTML" })
          .then((m) => {
            const seg = segs.get(e.index);
            if (seg) {
              seg.msgId = m.message_id;
              scheduleEdit(e.index);
            }
          })
          .catch(() => {});
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
          void logTurn({
            ts: Date.now(),
            chatId,
            userId: uid,
            sessionId: active.id,
            kind: "answer",
            text: seg.text,
          });
        }
        segs.delete(e.index);
        break;
      }
      case "thinking":
        break;
      case "usage":
        ses.addUsage(uid, e.inputTokens, e.outputTokens);
        await reply(msg.turnComplete(e));
        void logTurn({
          ts: Date.now(),
          chatId,
          userId: uid,
          sessionId: active.id,
          kind: "end",
          durationMs: e.durationMs,
          inputTokens: e.inputTokens,
          outputTokens: e.outputTokens,
        });
        break;
      case "error":
        await reply(msg.toolFail(e.message));
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
      signal: ac.signal,
      timeoutMs: TURN_TIMEOUT_MS,
      onEvent,
    });
  } catch (err: any) {
    await reply(msg.toolFail(String(err?.message ?? err)));
    void logTurn({
      ts: Date.now(),
      chatId,
      userId: uid,
      sessionId: active.id,
      kind: "error",
      error: String(err?.message ?? err),
    });
  } finally {
    ses.clearBusy(active.id);
  }
}
