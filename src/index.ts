import { Bot, Context, GrammyError, HttpError, InlineKeyboard } from "grammy";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";
import { probeInit, probeUsage } from "./claude.js";
import * as ses from "./session.js";
import * as update from "./update.js";
import r from "./personas/index.js";
import { runTurn } from "./runner.js";

const BOOT_AT = Date.now();

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

const replyTo = (ctx: Context) => (text: string) => reply(ctx, text);

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

async function handleSwitch(ctx: Context, arg: string): Promise<void> {
  const result = ses.switchTo(ctx.from!.id, arg);
  if (result.kind === "found") return reply(ctx, r.switched(result.session.name));
  if (result.kind === "ambiguous") return reply(ctx, r.ambiguous(arg, result.count));
  return reply(ctx, r.notFound(arg));
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
    const result = ses.deleteByPrefix(uid, arg);
    if (result.kind === "found")
      return reply(
        ctx,
        r.deletedSession(result.session.name, ses.sid8(result.session.id)),
      );
    if (result.kind === "ambiguous")
      return reply(ctx, r.ambiguous(arg, result.count));
    return reply(ctx, r.notFound(arg));
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

bot.command("update", async (ctx) => {
  const arg = (ctx.match?.trim() ?? "").toLowerCase();
  if (!arg) return reply(ctx, r.updateUsage());
  if (arg !== "gateway" && arg !== "claude") {
    return reply(ctx, r.updateUnknown(arg));
  }

  await ctx.replyWithChatAction("typing").catch(() => {});
  await reply(ctx, r.updateBegin(arg));

  try {
    const result =
      arg === "gateway"
        ? await update.updateGateway()
        : await update.updateClaude();
    await reply(
      ctx,
      r.updateResult(arg, result.before, result.after, result.changed, result.log),
    );
    if (arg === "gateway" && result.changed) {
      await reply(ctx, r.gatewayReloading());
      update.reloadProcess("agent-gateway");
    }
  } catch (err: any) {
    const msg = String(err?.stderr || err?.stdout || err?.message || err);
    await reply(ctx, r.updateError(arg, msg));
  }
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
  const result = ses.switchTo(ctx.from!.id, sid8);
  await ctx.answerCallbackQuery();
  if (result.kind !== "found") {
    await ctx.editMessageText(r.notFound(sid8).replace(/<[^>]+>/g, ""));
    return;
  }
  await ctx.editMessageText(`${r.tag.report}切換對象 → ${result.session.name}`, {
    parse_mode: "HTML",
  });
});

bot.callbackQuery(/^delete:(.+)$/, async (ctx) => {
  const sid8 = ctx.match[1];
  const result = ses.deleteByPrefix(ctx.from!.id, sid8);
  await ctx.answerCallbackQuery();
  if (result.kind !== "found") {
    await ctx.editMessageText(r.notFound(sid8).replace(/<[^>]+>/g, ""));
    return;
  }
  await ctx.editMessageText(
    `${r.tag.report}個體 ${result.session.name} (${sid8}) 已抹消。`,
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
  if (path) await runTurn(ctx, `${caption}\n\n圖片路徑：${path}`, replyTo(ctx));
});

bot.on("message:document", async (ctx) => {
  const doc = ctx.message.document;
  const path = await handleAttachment(
    ctx,
    doc.file_id,
    doc.file_name ?? `file-${Date.now()}`,
  );
  const caption = ctx.message.caption ?? "看一下這個檔案。";
  if (path) await runTurn(ctx, `${caption}\n\n檔案路徑：${path}`, replyTo(ctx));
});

bot.on("message:text", async (ctx) => {
  if (ctx.message.text.startsWith("/")) return;
  await runTurn(ctx, ctx.message.text, replyTo(ctx));
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
  { command: "resume", description: "喚回個體（無參數跳選單）" },
  { command: "clear", description: "停泊當前個體" },
  { command: "delete", description: "抹消個體（無參數跳選單）" },
  { command: "cancel", description: "中斷進行中的演算" },
  { command: "status", description: "系統狀態" },
  { command: "mcp", description: "MCP server 一覽與認證狀態" },
  { command: "skills", description: "可用 skills" },
  { command: "usage", description: "Claude Code 訂閱用量" },
  { command: "update", description: "升級 gateway / claude" },
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

console.log(`[boot] ${r.displayName} online.`);
await bot.start({
  drop_pending_updates: true,
  onStart: (me) => console.log(`[boot] @${me.username} ready.`),
});
