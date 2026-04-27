import { Bot, Context, GrammyError, HttpError, InlineKeyboard } from "grammy";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";
import {
  runClaude,
  probeInit,
  probeUsage,
  type ClaudeEvent,
} from "./claude.js";
import * as ses from "./session.js";
import * as r from "./raphael.js";

const BOOT_AT = Date.now();
const TURN_TIMEOUT_MS = 10 * 60_000;

const bot = new Bot(config.botToken);
await ses.loadAll();

bot.use(async (ctx, next) => {
  const uid = ctx.from?.id;
  if (!uid || !config.allowedUsers.has(uid)) {
    if (ctx.message) await ctx.reply(r.denied().replace(/<[^>]+>/g, ""));
    return;
  }
  await next();
});

async function reply(ctx: Context, text: string): Promise<void> {
  for (const chunk of r.splitForTelegram(text)) {
    try {
      await ctx.reply(chunk, { parse_mode: "HTML" });
    } catch (err: any) {
      console.warn("[reply] HTML failed:", err?.description ?? err);
      await ctx.reply(chunk.replace(/<[^>]+>/g, ""));
    }
  }
}

interface NewArgs {
  name: string;
  inPath?: string;
  description?: string;
}

function parseNewArgs(raw: string): NewArgs {
  const tokens: string[] = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) tokens.push(m[1] ?? m[2]);

  let name = `agent-${Date.now().toString(36).slice(-4)}`;
  let inPath: string | undefined;
  let description: string | undefined;
  const positional: string[] = [];

  for (let idx = 0; idx < tokens.length; idx++) {
    const t = tokens[idx];
    if (t === "--in") inPath = tokens[++idx];
    else if (t === "--desc") description = tokens[++idx];
    else positional.push(t);
  }
  if (positional.length > 0) name = positional[0];
  if (positional.length > 1 && !description) {
    description = positional.slice(1).join(" ");
  }
  if (inPath?.startsWith("~")) {
    inPath = inPath.replace(/^~/, process.env.HOME ?? "");
  }
  return { name, inPath, description };
}

function buildPicker(
  action: "resume" | "delete",
  rows: { name: string; sid8: string }[],
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const row of rows) {
    kb.text(`${row.name}  ·  ${row.sid8}`, `${action}:${row.sid8}`).row();
  }
  kb.text("✕ 取消", `cancel:${action}`);
  return kb;
}

bot.command("start", async (ctx) => {
  await reply(ctx, r.startupBanner());
});

bot.command("help", async (ctx) => {
  await reply(ctx, r.help());
});

bot.command("new", async (ctx) => {
  const args = parseNewArgs(ctx.match?.trim() ?? "");
  const s = ses.createSession(ctx.from!.id, args.name, {
    cwdOverride: args.inPath,
    description: args.description,
  });
  await reply(ctx, r.newSession(s.name, ses.sid8(s.id), s.cwd));
});

bot.command("clear", async (ctx) => {
  const parked = ses.clearActive(ctx.from!.id);
  await reply(
    ctx,
    parked ? r.parkedSession(parked.name, ses.sid8(parked.id)) : r.noActive(),
  );
});

bot.command("list", async (ctx) => {
  const uid = ctx.from!.id;
  const all = ses.listSessions(uid);
  const active = ses.activeSession(uid);
  await reply(
    ctx,
    r.listSessions(
      all.map((s) => ({
        name: s.name,
        sid8: ses.sid8(s.id),
        active: s.id === active?.id,
        turns: s.turnCount,
        lastActivityAt: s.lastActivityAt,
      })),
    ),
  );
});

bot.command("use", async (ctx) => {
  const arg = ctx.match?.trim();
  const uid = ctx.from!.id;
  if (arg) {
    const s = ses.switchTo(uid, arg);
    return reply(ctx, s ? r.switched(s.name) : r.notFound(arg));
  }
  const all = ses.listSessions(uid);
  const active = ses.activeSession(uid);
  const picks = all
    .filter((s) => s.id !== active?.id)
    .map((s) => ({ name: s.name, sid8: ses.sid8(s.id) }));
  if (picks.length === 0) return reply(ctx, r.pickerEmpty("resume"));
  await ctx.reply(r.pickerPrompt("resume"), {
    parse_mode: "HTML",
    reply_markup: buildPicker("resume", picks),
  });
});

bot.command("resume", async (ctx) => {
  const arg = ctx.match?.trim();
  const uid = ctx.from!.id;
  if (arg) {
    const s = ses.switchTo(uid, arg);
    return reply(ctx, s ? r.switched(s.name) : r.notFound(arg));
  }
  const all = ses.listSessions(uid);
  const active = ses.activeSession(uid);
  const picks = all
    .filter((s) => s.id !== active?.id)
    .map((s) => ({ name: s.name, sid8: ses.sid8(s.id) }));
  if (picks.length === 0) return reply(ctx, r.pickerEmpty("resume"));
  await ctx.reply(r.pickerPrompt("resume"), {
    parse_mode: "HTML",
    reply_markup: buildPicker("resume", picks),
  });
});

bot.command("delete", async (ctx) => {
  const arg = ctx.match?.trim();
  const uid = ctx.from!.id;
  if (arg) {
    const removed = ses.deleteSession(uid, arg);
    return reply(
      ctx,
      removed
        ? r.deletedSession(removed.name, ses.sid8(removed.id))
        : r.notFound(arg),
    );
  }
  const all = ses.listSessions(uid);
  const picks = all.map((s) => ({ name: s.name, sid8: ses.sid8(s.id) }));
  if (picks.length === 0) return reply(ctx, r.pickerEmpty("delete"));
  await ctx.reply(r.pickerPrompt("delete"), {
    parse_mode: "HTML",
    reply_markup: buildPicker("delete", picks),
  });
});

bot.command("cancel", async (ctx) => {
  const active = ses.activeSession(ctx.from!.id);
  if (!active) return reply(ctx, r.noActive());
  const ok = ses.cancel(active.id);
  await reply(ctx, ok ? r.cancelled() : r.nothingToCancel());
});

bot.command("mcp", async (ctx) => {
  await ctx.replyWithChatAction("typing").catch(() => {});
  const init = await probeInit();
  await reply(ctx, r.mcpList(init.mcpServers));
});

bot.command("skills", async (ctx) => {
  await ctx.replyWithChatAction("typing").catch(() => {});
  const init = await probeInit();
  await reply(ctx, r.skillsList(init.skills));
});

bot.command("usage", async (ctx) => {
  await ctx.replyWithChatAction("typing").catch(() => {});
  const bars = await probeUsage();
  await reply(ctx, r.usageBars(bars));
});

bot.command("status", async (ctx) => {
  const uid = ctx.from!.id;
  const active = ses.activeSession(uid);
  await reply(
    ctx,
    r.status({
      uptimeSec: Math.floor((Date.now() - BOOT_AT) / 1000),
      activeName: active?.name ?? null,
      activeSid8: active ? ses.sid8(active.id) : null,
      totalSessions: ses.listSessions(uid).length,
      busy: !!(active && ses.isBusy(active.id)),
    }),
  );
});

bot.callbackQuery(/^resume:(.+)$/, async (ctx) => {
  const sid8 = ctx.match[1];
  const s = ses.switchTo(ctx.from!.id, sid8);
  await ctx.answerCallbackQuery();
  if (!s) {
    await ctx.editMessageText(r.notFound(sid8).replace(/<[^>]+>/g, ""));
    return;
  }
  await ctx.editMessageText(`${r.tag.report}切換對象 → ${s.name}`, {
    parse_mode: "HTML",
  });
});

bot.callbackQuery(/^delete:(.+)$/, async (ctx) => {
  const sid8 = ctx.match[1];
  const removed = ses.deleteSession(ctx.from!.id, sid8);
  await ctx.answerCallbackQuery();
  if (!removed) {
    await ctx.editMessageText(r.notFound(sid8).replace(/<[^>]+>/g, ""));
    return;
  }
  await ctx.editMessageText(
    `${r.tag.report}個體 ${removed.name} (${sid8}) 已抹消。`,
    { parse_mode: "HTML" },
  );
});

bot.callbackQuery(/^cancel:.*$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.deleteMessage().catch(() => {});
});

async function handleAttachment(
  ctx: Context,
  fileId: string,
  filename: string,
): Promise<string | null> {
  const active = ses.activeSession(ctx.from!.id);
  if (!active) {
    await reply(ctx, r.noActive());
    return null;
  }
  await mkdir(active.cwd, { recursive: true });
  const file = await ctx.api.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    await reply(ctx, r.toolFail(`download failed: ${resp.status}`));
    return null;
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  const safeName = filename.replace(/[^\w.\- ]+/g, "_");
  const target = join(active.cwd, safeName);
  await writeFile(target, buf);
  await reply(ctx, r.attachmentReceived(safeName, target));
  return target;
}

bot.on("message:photo", async (ctx) => {
  const photo = ctx.message.photo.at(-1);
  if (!photo) return;
  const filename = `photo-${Date.now()}.jpg`;
  const path = await handleAttachment(ctx, photo.file_id, filename);
  const caption = ctx.message.caption ?? "看一下這張圖。";
  if (path) await runTurn(ctx, `${caption}\n\n圖片路徑：${path}`);
});

bot.on("message:document", async (ctx) => {
  const doc = ctx.message.document;
  const path = await handleAttachment(
    ctx,
    doc.file_id,
    doc.file_name ?? `file-${Date.now()}`,
  );
  const caption = ctx.message.caption ?? "看一下這個檔案。";
  if (path) await runTurn(ctx, `${caption}\n\n檔案路徑：${path}`);
});

async function runTurn(ctx: Context, prompt: string): Promise<void> {
  const uid = ctx.from!.id;
  const active = ses.activeSession(uid);
  if (!active) return reply(ctx, r.noActive());

  if (ses.isBusy(active.id)) return reply(ctx, r.busy());

  const isFirst = active.turnCount === 0;
  ses.bumpTurn(uid);
  const turnStart = Date.now();

  const ac = new AbortController();
  ses.setBusy(active.id, ac);
  await ctx.replyWithChatAction("typing").catch(() => {});

  // Per-segment streaming state (block index → buffered text + msg id)
  interface SegState {
    msgId: number | null;
    text: string;
    lastEditAt: number;
    pendingEdit: NodeJS.Timeout | null;
  }
  const segs = new Map<number, SegState>();
  const THROTTLE_MS = 500; // Telegram editMessageText 安全頻率

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
    if (elapsed >= THROTTLE_MS) {
      void flushSeg(idx, false);
      return;
    }
    if (!seg.pendingEdit) {
      seg.pendingEdit = setTimeout(() => {
        void flushSeg(idx, false);
      }, THROTTLE_MS - elapsed);
    }
  };

  const onEvent = async (e: ClaudeEvent) => {
    switch (e.kind) {
      case "tool_use":
        await reply(ctx, r.toolCall(e.name, e.input));
        break;
      case "tool_result":
        if (e.isError) await reply(ctx, r.toolFail(e.content));
        break;
      case "stream_text_start": {
        // Eager 建 placeholder 訊息，避免 throttle 觸發 race 同時建多條
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
          // 空文字段：placeholder 不留下垃圾
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
        await reply(ctx, r.turnComplete(e));
        break;
      case "error":
        await reply(ctx, r.toolFail(e.message));
        break;
      case "done":
        // 收尾：把任何還沒 stop 的 segment flush
        for (const idx of segs.keys()) await flushSeg(idx, true);
        segs.clear();
        break;
    }
    if (e.kind !== "done" && e.kind !== "usage" && e.kind !== "stream_text_delta") {
      await ctx.replyWithChatAction("typing").catch(() => {});
    }
  };

  try {
    await runClaude({
      sessionId: active.id,
      cwd: active.cwd,
      prompt,
      isFirst,
      description: active.description,
      signal: ac.signal,
      timeoutMs: TURN_TIMEOUT_MS,
      onEvent,
    });
  } catch (err: any) {
    await reply(ctx, r.toolFail(String(err?.message ?? err)));
  } finally {
    ses.clearBusy(active.id);
  }
}

bot.on("message:text", async (ctx) => {
  if (ctx.message.text.startsWith("/")) return;
  await runTurn(ctx, ctx.message.text);
});

bot.catch((err) => {
  const e = err.error;
  if (e instanceof GrammyError) console.error("[grammy]", e.description);
  else if (e instanceof HttpError) console.error("[http]", e);
  else console.error("[bot]", e);
});

await bot.api.setMyCommands([
  { command: "start", description: "啟動畫面" },
  { command: "help", description: "指令一覽" },
  { command: "new", description: "創設新個體" },
  { command: "list", description: "所有個體" },
  { command: "use", description: "切換 active" },
  { command: "resume", description: "喚回個體（無參數跳選單）" },
  { command: "clear", description: "停泊當前個體" },
  { command: "delete", description: "抹消個體（無參數跳選單）" },
  { command: "cancel", description: "中斷進行中的演算" },
  { command: "status", description: "系統狀態" },
  { command: "mcp", description: "MCP server 一覽與認證狀態" },
  { command: "skills", description: "可用 skills" },
  { command: "usage", description: "token 使用量報告" },
]);

console.log("[boot] Raphael online.");
await bot.start({
  drop_pending_updates: true,
  onStart: (me) => console.log(`[boot] @${me.username} ready.`),
});
