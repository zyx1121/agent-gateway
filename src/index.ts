import { Bot, Context, GrammyError, HttpError, InlineKeyboard } from "grammy";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";
import * as ses from "./session.js";
import * as pty from "./pty.js";
import * as msg from "./messages.js";
import { runTurn } from "./runner.js";

const BOOT_AT = Date.now();

const bot = new Bot(config.botToken);
await ses.loadAll();

bot.use(async (ctx, next) => {
  const uid = ctx.from?.id;
  if (!uid || !config.allowedUsers.has(uid)) {
    if (ctx.message) await ctx.reply(msg.denied().replace(/<[^>]+>/g, ""));
    return;
  }
  await next();
});

async function reply(ctx: Context, text: string): Promise<void> {
  for (const chunk of msg.splitForTelegram(text)) {
    try {
      await ctx.reply(chunk, { parse_mode: "HTML" });
    } catch (err: any) {
      console.warn("[reply] HTML failed:", err?.description ?? err);
      await ctx.reply(chunk.replace(/<[^>]+>/g, ""));
    }
  }
}

const replyTo = (ctx: Context) => (text: string) => reply(ctx, text);

interface NewArgs {
  name: string;
  inPath?: string;
}

function parseNewArgs(raw: string): NewArgs {
  const tokens: string[] = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) tokens.push(m[1] ?? m[2]);

  let name = `agent-${Date.now().toString(36).slice(-4)}`;
  let inPath: string | undefined;
  const positional: string[] = [];

  for (let idx = 0; idx < tokens.length; idx++) {
    const t = tokens[idx];
    if (t === "--in") inPath = tokens[++idx];
    else positional.push(t);
  }
  if (positional.length > 0) name = positional[0];
  if (inPath?.startsWith("~")) {
    inPath = inPath.replace(/^~/, process.env.HOME ?? "");
  }
  return { name, inPath };
}

function buildPicker(
  action: "resume" | "delete",
  rows: { name: string; sid8: string }[],
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const row of rows) {
    kb.text(`${row.name}  ·  ${row.sid8}`, `${action}:${row.sid8}`).row();
  }
  if (action === "delete" && rows.length > 1) {
    kb.text(`!! delete all (${rows.length})`, `delete:__all__`).row();
  }
  kb.text("x cancel", `cancel:${action}`);
  return kb;
}

bot.command("start", async (ctx) => {
  await reply(ctx, msg.startupBanner());
});

bot.command("help", async (ctx) => {
  await reply(ctx, msg.help());
});

bot.command("new", async (ctx) => {
  const args = parseNewArgs(ctx.match?.trim() ?? "");
  const s = ses.createSession(ctx.from!.id, args.name, {
    cwdOverride: args.inPath,
  });
  await reply(ctx, msg.newSession(s.name, ses.sid8(s.id), s.cwd));
});

bot.command("clear", async (ctx) => {
  const parked = ses.clearActive(ctx.from!.id);
  await reply(
    ctx,
    parked ? msg.parkedSession(parked.name, ses.sid8(parked.id)) : msg.noActive(),
  );
});

bot.command("list", async (ctx) => {
  const uid = ctx.from!.id;
  const all = ses.listSessions(uid);
  const active = ses.activeSession(uid);
  await reply(
    ctx,
    msg.listSessions(
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

async function handleSwitch(ctx: Context, arg: string): Promise<void> {
  const result = ses.switchTo(ctx.from!.id, arg);
  if (result.kind === "found") return reply(ctx, msg.switched(result.session.name));
  if (result.kind === "ambiguous") return reply(ctx, msg.ambiguous(arg, result.count));
  return reply(ctx, msg.notFound(arg));
}

bot.command("resume", async (ctx) => {
  const arg = ctx.match?.trim();
  const uid = ctx.from!.id;
  if (arg) return handleSwitch(ctx, arg);
  const all = ses.listSessions(uid);
  const active = ses.activeSession(uid);
  const picks = all
    .filter((s) => s.id !== active?.id)
    .map((s) => ({ name: s.name, sid8: ses.sid8(s.id) }));
  if (picks.length === 0) return reply(ctx, msg.pickerEmpty("resume"));
  await ctx.reply(msg.pickerPrompt("resume"), {
    parse_mode: "HTML",
    reply_markup: buildPicker("resume", picks),
  });
});

bot.command("delete", async (ctx) => {
  const arg = ctx.match?.trim();
  const uid = ctx.from!.id;
  if (arg === "all") {
    const n = ses.deleteAll(uid);
    return reply(ctx, msg.deletedAll(n));
  }
  if (arg) {
    const result = ses.deleteByPrefix(uid, arg);
    if (result.kind === "found")
      return reply(
        ctx,
        msg.deletedSession(result.session.name, ses.sid8(result.session.id)),
      );
    if (result.kind === "ambiguous")
      return reply(ctx, msg.ambiguous(arg, result.count));
    return reply(ctx, msg.notFound(arg));
  }
  const all = ses.listSessions(uid);
  const picks = all.map((s) => ({ name: s.name, sid8: ses.sid8(s.id) }));
  if (picks.length === 0) return reply(ctx, msg.pickerEmpty("delete"));
  await ctx.reply(msg.pickerPrompt("delete"), {
    parse_mode: "HTML",
    reply_markup: buildPicker("delete", picks),
  });
});

bot.command("cancel", async (ctx) => {
  const active = ses.activeSession(ctx.from!.id);
  if (!active) return reply(ctx, msg.noActive());
  const ok = ses.cancel(active.id);
  await reply(ctx, ok ? msg.cancelled() : msg.nothingToCancel());
});

// chat_id → resolver for the next text message (claude OAuth code paste-back).
const awaitingCodeByChat = new Map<number, (code: string) => void>();

bot.command("login", async (ctx) => {
  if (!ctx.chat) return;
  const chatId = ctx.chat.id;
  await reply(ctx, msg.loginBegin());

  // Fire-and-forget. grammy dispatches updates sequentially per chat; if we
  // awaited loginFlow here (it blocks up to 5 min waiting for the OAuth URL
  // and the user's pasted code), the message carrying the code itself would
  // never get dispatched — deadlock by self-blocking.
  void pty
    .loginFlow({
      onUrl: (url) => reply(ctx, msg.loginUrl(url)),
      onCodePrompt: () =>
        new Promise<string>((resolve) => {
          awaitingCodeByChat.set(chatId, resolve);
          reply(ctx, msg.loginCodePrompt()).catch(() => {});
        }),
    })
    .then((result) => {
      awaitingCodeByChat.delete(chatId);
      if (result.ok) return reply(ctx, msg.loginOk(result.tail));
      return reply(ctx, msg.loginFail(result.error ?? "unknown", result.tail));
    })
    .catch((err) => {
      awaitingCodeByChat.delete(chatId);
      reply(ctx, msg.loginFail(String(err?.message ?? err), "")).catch(
        () => {},
      );
    });
});

bot.command("status", async (ctx) => {
  const uid = ctx.from!.id;
  const active = ses.activeSession(uid);
  await reply(
    ctx,
    msg.status({
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
  const result = ses.switchTo(ctx.from!.id, sid8);
  await ctx.answerCallbackQuery();
  if (result.kind !== "found") {
    await ctx.editMessageText(msg.notFound(sid8).replace(/<[^>]+>/g, ""));
    return;
  }
  await ctx.editMessageText(`<b>>></b> ${result.session.name}`, {
    parse_mode: "HTML",
  });
});

bot.callbackQuery(/^delete:(.+)$/, async (ctx) => {
  const sid8 = ctx.match[1];
  await ctx.answerCallbackQuery();
  if (sid8 === "__all__") {
    const n = ses.deleteAll(ctx.from!.id);
    await ctx.editMessageText(msg.deletedAll(n).replace(/<[^>]+>/g, ""));
    return;
  }
  const result = ses.deleteByPrefix(ctx.from!.id, sid8);
  if (result.kind !== "found") {
    await ctx.editMessageText(msg.notFound(sid8).replace(/<[^>]+>/g, ""));
    return;
  }
  await ctx.editMessageText(
    `<b>>> deleted</b> ${result.session.name} (${sid8})`,
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
    await reply(ctx, msg.noActive());
    return null;
  }
  await mkdir(active.cwd, { recursive: true });
  const file = await ctx.api.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    await reply(ctx, msg.toolFail(`download failed: ${resp.status}`));
    return null;
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  const safeName = filename.replace(/[^\w.\- ]+/g, "_");
  const target = join(active.cwd, safeName);
  await writeFile(target, buf);
  await reply(ctx, msg.attachmentReceived(safeName, target));
  return target;
}

bot.on("message:photo", async (ctx) => {
  const photo = ctx.message.photo.at(-1);
  if (!photo) return;
  const filename = `photo-${Date.now()}.jpg`;
  const path = await handleAttachment(ctx, photo.file_id, filename);
  const caption = ctx.message.caption ?? "take a look at this image.";
  if (path) await runTurn(ctx, `${caption}\n\nimage path: ${path}`, replyTo(ctx));
});

bot.on("message:document", async (ctx) => {
  const doc = ctx.message.document;
  const path = await handleAttachment(
    ctx,
    doc.file_id,
    doc.file_name ?? `file-${Date.now()}`,
  );
  const caption = ctx.message.caption ?? "take a look at this file.";
  if (path) await runTurn(ctx, `${caption}\n\nfile path: ${path}`, replyTo(ctx));
});

bot.on("message:text", async (ctx) => {
  if (ctx.message.text.startsWith("/")) return;

  // While /login is awaiting an OAuth code on this chat, hijack the next
  // text message and pipe it back to the PTY instead of running a turn.
  if (ctx.chat) {
    const codeResolver = awaitingCodeByChat.get(ctx.chat.id);
    if (codeResolver) {
      awaitingCodeByChat.delete(ctx.chat.id);
      codeResolver(ctx.message.text);
      await reply(ctx, msg.loginCodeReceived());
      return;
    }
  }

  await runTurn(ctx, ctx.message.text, replyTo(ctx));
});

bot.catch((err) => {
  const e = err.error;
  if (e instanceof GrammyError) console.error("[grammy]", e.description);
  else if (e instanceof HttpError) console.error("[http]", e);
  else console.error("[bot]", e);
});

await bot.api.setMyCommands([
  { command: "start", description: "boot banner" },
  { command: "help", description: "command list" },
  { command: "new", description: "create a new session" },
  { command: "list", description: "all sessions" },
  { command: "resume", description: "resume / switch (no arg → picker)" },
  { command: "clear", description: "park current session" },
  { command: "delete", description: "delete session (no arg → picker)" },
  { command: "cancel", description: "interrupt running turn" },
  { command: "status", description: "system status" },
  { command: "login", description: "PTY-based claude OAuth" },
]);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received`);
  try {
    await bot.stop();
  } catch (err) {
    console.warn("[shutdown] bot.stop failed:", err);
  }
  const cancelled = ses.cancelAll();
  if (cancelled > 0) console.log(`[shutdown] aborted ${cancelled} running turns`);
  await ses.flushNow();
  console.log("[shutdown] sessions persisted, bye");
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// Polling can fail unrecoverably (e.g. 409 conflict during reload races,
// invalid token). Surface the error and exit so pm2 respawns us instead of
// staying alive but silently no longer fetching updates.
process.on("unhandledRejection", (err) => {
  console.error("[fatal] unhandledRejection:", err);
  process.exit(1);
});

console.log(`[boot] outpost · ${config.agentName} online.`);
bot
  .start({
    drop_pending_updates: true,
    onStart: (me) => console.log(`[boot] @${me.username} ready.`),
  })
  .catch((err) => {
    console.error("[boot] polling crashed, exiting for pm2 restart:", err);
    process.exit(1);
  });
