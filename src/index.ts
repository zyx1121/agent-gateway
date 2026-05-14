import { Bot, Context, GrammyError, HttpError } from "grammy";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";
import * as msg from "./messages.js";
import { dispatchInbound } from "./runner.js";
import { DaemonSocket } from "./socket.js";
import { Supervisor } from "./supervisor.js";

// Boot-time config validation. config.ts is side-effect-free so subcommands
// like `outpost inject` can run without these env vars; daemon mode demands
// them. Bail out clean instead of crashing into pm2's restart loop.
function fatal(reason: string): never {
  console.error(`[fatal] ${reason}`);
  process.exit(1);
}
if (!config.botToken) fatal("TELEGRAM_BOT_TOKEN missing — set it in .env or env");
if (config.allowedUsers.size === 0)
  fatal("ALLOWED_USER_IDS is empty — bot would reject every user");

const BOOT_AT = Date.now();
const bot = new Bot(config.botToken);
let msgsIn = 0;
let msgsOut = 0;

async function readClaudeRssBytes(pid: number): Promise<number | null> {
  try {
    const text = await readFile(`/proc/${pid}/status`, "utf8");
    const m = /^VmRSS:\s+(\d+)\s+kB/m.exec(text);
    return m ? Number(m[1]) * 1024 : null;
  } catch {
    return null;
  }
}

// chat_id (as it travels through the channel protocol) is the string
// "tg:<telegram_chat_id>". The number is what grammY's sendMessage needs.
const decodeChatId = (raw: string): number | null => {
  if (!raw.startsWith("tg:")) return null;
  const n = Number(raw.slice(3));
  return Number.isFinite(n) ? n : null;
};
const encodeChatId = (chatId: number): string => `tg:${chatId}`;

const supervisor = new Supervisor();

// Telegram typing indicator auto-expires after ~5s. Refresh on a 4s tick
// while claude is working, clear when the reply lands. Hard cap at 10 min
// — if claude hasn't replied by then it's almost certainly stuck, so we
// stop pinging and tell the user to /clear.
const TYPING_REFRESH_MS = 4_000;
const TYPING_MAX_MS = 10 * 60_000;
const typingTimers = new Map<
  number,
  { interval: NodeJS.Timeout; safety: NodeJS.Timeout }
>();
function startTyping(chatId: number): void {
  if (typingTimers.has(chatId)) return;
  const ping = (): void => {
    void bot.api.sendChatAction(chatId, "typing").catch(() => {});
  };
  ping();
  const interval = setInterval(ping, TYPING_REFRESH_MS);
  const safety = setTimeout(() => {
    stopTyping(chatId);
    void bot.api
      .sendMessage(
        chatId,
        "claude 沒回應 10 分鐘，大概卡住了。送 /clear 重啟試試。",
      )
      .catch(() => {});
  }, TYPING_MAX_MS);
  typingTimers.set(chatId, { interval, safety });
}
function stopTyping(chatId: number): void {
  const t = typingTimers.get(chatId);
  if (t) {
    clearInterval(t.interval);
    clearTimeout(t.safety);
  }
  typingTimers.delete(chatId);
}

const preview = (s: string, n = 120): string =>
  s.length <= n ? s : `${s.slice(0, n)}…(+${s.length - n})`;

const sock = new DaemonSocket(config.socketPath, {
  onHello: (hello) => {
    console.log(
      `[socket] hello protocol=${hello.protocol} pid=${hello.pid} ver=${hello.channel_version}`,
    );
  },
  onDisconnect: () => console.log("[socket] channel disconnected"),
  onReply: async (reply) => {
    const chatId = decodeChatId(reply.chat_id);
    if (chatId === null) {
      console.warn(`[reply] unparseable chat_id=${reply.chat_id}`);
      return { ok: false, error: `unparseable chat_id ${reply.chat_id}` };
    }
    console.log(`[reply] ${reply.chat_id} ${reply.text.length}c: ${preview(reply.text)}`);
    stopTyping(chatId);
    try {
      await sendReply(chatId, reply.text);
      msgsOut++;
      return { ok: true };
    } catch (err: any) {
      const desc = String(err?.description ?? err?.message ?? err);
      console.warn(`[reply] tg send failed: ${desc}`);
      return { ok: false, error: desc };
    }
  },
});

async function sendReply(chatId: number, text: string): Promise<void> {
  for (const chunk of msg.splitForTelegram(msg.finalAnswer(text))) {
    try {
      await bot.api.sendMessage(chatId, chunk, { parse_mode: "HTML" });
    } catch (err: any) {
      console.warn("[reply] HTML failed:", err?.description ?? err);
      await bot.api.sendMessage(chatId, chunk.replace(/<[^>]+>/g, ""));
    }
  }
}

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

bot.command("start", (ctx) => reply(ctx, msg.startupBanner()));
bot.command("help", (ctx) => reply(ctx, msg.help()));
bot.command("status", async (ctx) => {
  const pid = supervisor.pid();
  const rss = pid ? await readClaudeRssBytes(pid) : null;
  await reply(
    ctx,
    msg.status({
      uptimeSec: Math.floor((Date.now() - BOOT_AT) / 1000),
      claudePid: pid,
      claudeRssBytes: rss,
      msgsIn,
      msgsOut,
    }),
  );
});
bot.command("clear", async (ctx) => {
  if (ctx.chat) stopTyping(ctx.chat.id);
  await reply(ctx, "session reset — fresh claude in a few seconds.");
  supervisor.restart();
});

async function handleAttachment(
  ctx: Context,
  fileId: string,
  filename: string,
): Promise<string | null> {
  await mkdir(config.workspace, { recursive: true });
  const file = await ctx.api.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    await reply(ctx, msg.toolFail(`download failed: ${resp.status}`));
    return null;
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  const safeName = filename.replace(/[^\w.\- ]+/g, "_");
  const target = join(config.workspace, safeName);
  await writeFile(target, buf);
  await reply(ctx, msg.attachmentReceived(safeName, target));
  return target;
}

function dispatch(ctx: Context, content: string): void {
  const chat = ctx.chat;
  const from = ctx.from;
  if (!chat || !from) return;
  console.log(
    `[inbound] tg:${chat.id} ${from.username ?? from.id} ${content.length}c: ${preview(content)}`,
  );
  msgsIn++;
  startTyping(chat.id);
  const result = dispatchInbound(sock, content, {
    chat_id: encodeChatId(chat.id),
    user: from.username ?? String(from.id),
    ts: new Date().toISOString(),
  });
  if (!result.ok) {
    console.warn(`[inbound] dispatch failed: ${result.error}`);
    stopTyping(chat.id);
    void reply(ctx, msg.toolFail(result.error ?? "dispatch failed"));
  }
}

bot.on("message:photo", async (ctx) => {
  const photo = ctx.message.photo.at(-1);
  if (!photo) return;
  const filename = `photo-${Date.now()}.jpg`;
  const path = await handleAttachment(ctx, photo.file_id, filename);
  const caption = ctx.message.caption ?? "take a look at this image.";
  if (path) dispatch(ctx, `${caption}\n\nimage path: ${path}`);
});

bot.on("message:document", async (ctx) => {
  const doc = ctx.message.document;
  const path = await handleAttachment(
    ctx,
    doc.file_id,
    doc.file_name ?? `file-${Date.now()}`,
  );
  const caption = ctx.message.caption ?? "take a look at this file.";
  if (path) dispatch(ctx, `${caption}\n\nfile path: ${path}`);
});

// Registered bot.command() handlers above already consume /start, /help,
// /status. Anything else starting with `/` (like Claude Code's own slash
// commands — /plugin, /mcp, /skills, /init…) falls through here and gets
// dispatched to claude verbatim.
bot.on("message:text", (ctx) => {
  dispatch(ctx, ctx.message.text);
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
  { command: "status", description: "daemon uptime" },
  { command: "clear", description: "reset claude — fresh conversation" },
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
  await supervisor.stop();
  await sock.close();
  console.log("[shutdown] bye");
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

process.on("unhandledRejection", (err) => {
  console.error("[fatal] unhandledRejection:", err);
  process.exit(1);
});

await sock.listen();
await supervisor.start();

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
