import { Bot, webhookCallback, InlineKeyboard, type Context } from "grammy";
import type { Message } from "grammy/types";

interface Env {
  BOT_TOKEN: string;
  OWNER_ID: string;
  DM_GATEWAY_KV: KVNamespace;
}

// --- 配置 ---

const FAIL_MAX = 1;
const LOCK_SECONDS = 180;
const VERIFY_TTL_HOURS = 72;

interface Question {
  q: string;
  opts: string[];
  ans: string;
}

const QUESTIONS: Question[] = [
  { q: "天空是什么颜色？", opts: ["蓝色", "红色", "绿色", "黑色", "白色", "黄色"], ans: "蓝色" },
  { q: "中国的首都是？", opts: ["北京", "上海", "广州", "深圳", "杭州", "成都"], ans: "北京" },
  { q: "一年有几个季节？", opts: ["四季", "三季", "五季", "两季", "六季", "七季"], ans: "四季" },
  { q: "太阳从哪边升起？", opts: ["东方", "西方", "南方", "北方", "天上", "地下"], ans: "东方" },
  { q: "哪个是动物？", opts: ["猫", "桌子", "石头", "水", "云", "花"], ans: "猫" },
  { q: "2 + 3 等于几？", opts: ["5", "4", "6", "3", "7", "8"], ans: "5" },
  { q: "火是什么颜色？", opts: ["红色", "蓝色", "绿色", "黄色", "白色", "黑色"], ans: "红色" },
  { q: "一周有几天？", opts: ["七天", "五天", "六天", "三天", "十天", "四天"], ans: "七天" },
  { q: "以下哪个是水果？", opts: ["苹果", "土豆", "白菜", "大米", "鸡蛋", "牛奶"], ans: "苹果" },
  { q: "雪是什么颜色？", opts: ["白色", "黑色", "红色", "蓝色", "绿色", "棕色"], ans: "白色" },
];

// --- 工具函数 ---

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildCaptchaKeyboard(options: string[]): InlineKeyboard {
  const row = options.map((opt) => InlineKeyboard.text(opt, `verify:${opt}`));
  return InlineKeyboard.from([row.slice(0, 3), row.slice(3, 6)]);
}

function extractUserId(text: string): number | null {
  const m = text.match(/用户 ID:\s*(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

// --- KV helpers ---

async function isVerified(kv: KVNamespace, userId: number): Promise<boolean> {
  const v = await kv.get(`verified:${userId}`);
  if (!v) return false;
  const verifiedAt = parseInt(v, 10);
  const elapsed = (Date.now() - verifiedAt) / 1000 / 3600;
  return elapsed < VERIFY_TTL_HOURS;
}

async function addVerified(kv: KVNamespace, userId: number): Promise<void> {
  const ts = String(Date.now());
  await kv.put(`verified:${userId}`, ts, { expirationTtl: VERIFY_TTL_HOURS * 3600 + 600 });
}

async function getVerifiedTime(kv: KVNamespace, userId: number): Promise<number | null> {
  const v = await kv.get(`verified:${userId}`);
  return v ? parseInt(v, 10) : null;
}

async function removeVerified(kv: KVNamespace, userId: number): Promise<void> {
  await kv.delete(`verified:${userId}`);
}

async function getPending(kv: KVNamespace, userId: number): Promise<string | null> {
  return kv.get(`pending:${userId}`);
}

async function setPending(kv: KVNamespace, userId: number, answer: string): Promise<void> {
  await kv.put(`pending:${userId}`, answer, { expirationTtl: 300 });
}

async function deletePending(kv: KVNamespace, userId: number): Promise<void> {
  await kv.delete(`pending:${userId}`);
}

async function getFailCount(kv: KVNamespace, userId: number): Promise<number> {
  const v = await kv.get(`fail:${userId}`);
  return v ? parseInt(v, 10) : 0;
}

async function incrementFailCount(kv: KVNamespace, userId: number): Promise<number> {
  const count = await getFailCount(kv, userId) + 1;
  await kv.put(`fail:${userId}`, String(count), { expirationTtl: 3600 });
  return count;
}

async function resetFailCount(kv: KVNamespace, userId: number): Promise<void> {
  await kv.delete(`fail:${userId}`);
}

async function lockUser(kv: KVNamespace, userId: number): Promise<void> {
  const expiresAt = Date.now() + LOCK_SECONDS * 1000;
  await kv.put(`lock:${userId}`, String(expiresAt), { expirationTtl: LOCK_SECONDS + 10 });
}

async function getLockRemaining(kv: KVNamespace, userId: number): Promise<number> {
  const v = await kv.get(`lock:${userId}`);
  if (!v) return 0;
  const remaining = Math.ceil((parseInt(v, 10) - Date.now()) / 1000);
  return remaining > 0 ? remaining : 0;
}

// --- Message forwarding ---
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMsg = any;

async function forwardToOwner(
  api: Bot["api"],
  ownerId: number,
  userId: number,
  userName: string,
  msg: Message,
) {
  const header = `💬 来自 ${userName} 的消息：\n用户 ID: ${userId}\n`;
  const suffix = `\n\n用户 ID: ${userId}`;
  const m = msg as AnyMsg;

  if (m.text) {
    await api.sendMessage(ownerId, `${header}\n${m.text}`);
  } else if (m.sticker) {
    await api.sendMessage(ownerId, header);
    await api.sendSticker(ownerId, m.sticker.file_id);
  } else if (m.photo) {
    const fileId = m.photo[m.photo.length - 1].file_id;
    await api.sendPhoto(ownerId, fileId, { caption: `${header}${(m.caption || "") + suffix}` });
  } else if (m.video) {
    await api.sendVideo(ownerId, m.video.file_id, { caption: `${header}${(m.caption || "") + suffix}` });
  } else if (m.video_note) {
    await api.sendMessage(ownerId, header);
    await api.sendVideoNote(ownerId, m.video_note.file_id);
  } else if (m.voice) {
    await api.sendVoice(ownerId, m.voice.file_id, { caption: `${header}${(m.caption || "") + suffix}` });
  } else if (m.audio) {
    await api.sendAudio(ownerId, m.audio.file_id, { caption: `${header}${(m.caption || "") + suffix}` });
  } else if (m.document) {
    await api.sendDocument(ownerId, m.document.file_id, { caption: `${header}${(m.caption || "") + suffix}` });
  } else if (m.animation) {
    await api.sendAnimation(ownerId, m.animation.file_id, { caption: `${header}${(m.caption || "") + suffix}` });
  } else if (m.location) {
    await api.sendMessage(ownerId, header);
    await api.sendLocation(ownerId, m.location.latitude, m.location.longitude);
  } else if (m.contact) {
    await api.sendMessage(ownerId, header);
    await api.sendContact(ownerId, m.contact.phone_number, m.contact.first_name, {
      last_name: m.contact.last_name || "",
    });
  } else {
    await api.sendMessage(ownerId, header);
    await api.forwardMessage(ownerId, m.chat.id, m.message_id);
  }
}

async function replyToUser(
  api: Bot["api"],
  targetId: number,
  msg: Message,
) {
  const prefix = "💬 主人回复：\n";
  const m = msg as AnyMsg;

  if (m.text) {
    await api.sendMessage(targetId, `${prefix}${m.text}`);
  } else if (m.sticker) {
    await api.sendSticker(targetId, m.sticker.file_id);
  } else if (m.photo) {
    const fileId = m.photo[m.photo.length - 1].file_id;
    await api.sendPhoto(targetId, fileId, { caption: m.caption || "" });
  } else if (m.video) {
    await api.sendVideo(targetId, m.video.file_id, { caption: m.caption || "" });
  } else if (m.video_note) {
    await api.sendVideoNote(targetId, m.video_note.file_id);
  } else if (m.voice) {
    await api.sendVoice(targetId, m.voice.file_id, { caption: m.caption || "" });
  } else if (m.audio) {
    await api.sendAudio(targetId, m.audio.file_id, { caption: m.caption || "" });
  } else if (m.document) {
    await api.sendDocument(targetId, m.document.file_id, { caption: m.caption || "" });
  } else if (m.animation) {
    await api.sendAnimation(targetId, m.animation.file_id, { caption: m.caption || "" });
  } else if (m.location) {
    await api.sendLocation(targetId, m.location.latitude, m.location.longitude);
  } else {
    await api.forwardMessage(targetId, m.chat.id, m.message_id);
  }
}

// --- Captcha ---

async function showCaptcha(bot: Bot, kv: KVNamespace, chatId: number, userId: number) {
  const remaining = await getLockRemaining(kv, userId);
  if (remaining > 0) {
    await bot.api.sendMessage(chatId, `🚫 验证失败次数过多，请等待 ${remaining} 秒后再试。`);
    return;
  }

  const pick = QUESTIONS[Math.floor(Math.random() * QUESTIONS.length)];
  const options = shuffle(pick.opts);
  const failCount = await getFailCount(kv, userId);
  const attemptsLeft = FAIL_MAX - failCount;

  await setPending(kv, userId, pick.ans);
  await bot.api.sendMessage(chatId, `🤖 你想联系主人，请先验证你是真人：\n\n❓ ${pick.q}\n\n剩余尝试次数：${attemptsLeft}`, {
    reply_markup: buildCaptchaKeyboard(options),
  });
}

// --- Bot factory ---

let botInstance: Bot | null = null;
let botFingerprint = "";

function makeFingerprint(token: string, ownerId: number): string {
  return `${token}::${ownerId}`;
}

function getOrCreateBot(token: string, ownerId: number, kv: KVNamespace): Bot {
  const fp = makeFingerprint(token, ownerId);
  if (botInstance && botFingerprint === fp) return botInstance;

  botFingerprint = fp;
  const bot = new Bot(token);

  // 注册命令列表
  bot.api.setMyCommands([
    { command: "start", description: "开始验证 / 查看状态" },
    { command: "status", description: "查看验证状态和剩余时间" },
    { command: "unverify", description: "撤销用户验证（仅主人）" },
  ]).catch(() => {});

  bot.command("start", async (ctx) => {
    const userId = ctx.from!.id;
    if (userId === ownerId) {
      await ctx.reply("你是管理员，可以直接发消息给我，我会帮你转发。\n\n命令：\n/unverify <用户ID> — 撤销用户验证");
      return;
    }
    const verified = await isVerified(kv, userId);
    if (verified) {
      const vt = await getVerifiedTime(kv, userId);
      const remain = vt ? Math.max(0, Math.ceil(VERIFY_TTL_HOURS - (Date.now() - vt) / 1000 / 3600)) : 0;
      await ctx.reply(`你已经通过验证，直接发消息给我即可转达给主人。\n\n⏰ 验证剩余 ${remain} 小时`);
      return;
    }
    await showCaptcha(bot, kv, ctx.chat!.id, userId);
  });

  bot.command("status", async (ctx) => {
    const userId = ctx.from!.id;
    const verified = await isVerified(kv, userId);
    if (verified) {
      const vt = await getVerifiedTime(kv, userId);
      const remain = vt ? Math.max(0, Math.ceil(VERIFY_TTL_HOURS - (Date.now() - vt) / 1000 / 3600)) : 0;
      await ctx.reply(`✅ 已验证\n⏰ 剩余 ${remain} 小时\n📋 用户 ID: ${userId}`);
    } else {
      const locked = await getLockRemaining(kv, userId);
      if (locked > 0) {
        await ctx.reply(`🚫 已锁定，请等待 ${locked} 秒`);
      } else {
        await ctx.reply("❌ 未验证，请发送 /start 完成验证。");
      }
    }
  });

  bot.command("unverify", async (ctx) => {
    const userId = ctx.from!.id;
    if (userId !== ownerId) return;
    const text = ctx.message?.text || "";
    const parts = text.split(/\s+/);
    const targetId = parts[1] ? parseInt(parts[1], 10) : null;
    if (!targetId) {
      await ctx.reply("用法：/unverify <用户ID>\n\n用户 ID 可以从转发消息头部获取。");
      return;
    }
    await removeVerified(kv, targetId);
    await ctx.reply(`✅ 已将用户 ${targetId} 的验证状态重置。`);
    try { await bot.api.sendMessage(targetId, "⚠️ 你的验证已过期，请重新发送 /start 完成验证。"); } catch { /* ignore */ }
  });

  bot.on("callback_query:data", async (ctx: Context) => {
    const userId = ctx.from!.id;
    const data = ctx.callbackQuery!.data!;

    if (!data.startsWith("verify:")) return;

    const selected = data.slice(7);
    const correct = await getPending(kv, userId);

    if (!correct) {
      await ctx.answerCallbackQuery({ text: "验证已超时，请重新发送 /start", show_alert: true });
      try { await ctx.editMessageText("验证已超时，请重新发送 /start"); } catch { /* ignore */ }
      return;
    }

    if (selected === correct) {
      await resetFailCount(kv, userId);
      await addVerified(kv, userId);
      await deletePending(kv, userId);
      await ctx.answerCallbackQuery({ text: "🎉 验证通过！" });
      await ctx.editMessageText(`✅ 验证通过！你的消息将转达给主人。主人回复后你会收到通知。\n\n⏰ 验证有效期 ${VERIFY_TTL_HOURS / 24} 天，过期需重新验证。`);
    } else {
      const failCount = await incrementFailCount(kv, userId);
      if (failCount >= FAIL_MAX) {
        await lockUser(kv, userId);
        await ctx.answerCallbackQuery({ text: "❌ 验证失败，已锁定 3 分钟", show_alert: true });
        await ctx.editMessageText(`🚫 验证失败！你已被锁定 ${LOCK_SECONDS / 60} 分钟，请稍后再试。`);
        await deletePending(kv, userId);
      } else {
        const left = FAIL_MAX - failCount;
        await ctx.answerCallbackQuery({ text: `❌ 选择错误，还剩 ${left} 次机会`, show_alert: true });
        const pick = QUESTIONS[Math.floor(Math.random() * QUESTIONS.length)];
        const options = shuffle(pick.opts);
        await setPending(kv, userId, pick.ans);
        await ctx.editMessageText(`🤖 请先验证你是真人：\n\n❓ ${pick.q}\n\n剩余尝试次数：${left}`, {
          reply_markup: buildCaptchaKeyboard(options),
        });
      }
    }
  });

  bot.on("message", async (ctx: Context) => {
    const msg = ctx.message!;
    const userId = ctx.from!.id;

    if (msg.text?.startsWith("/")) return;

    const userName = ctx.from!.first_name || "未知";

    if (userId === ownerId) {
      const replied = msg.reply_to_message;
      if (replied) {
        const sourceText = (replied as AnyMsg).text || (replied as AnyMsg).caption || "";
        const targetId = extractUserId(sourceText);
        if (targetId) {
          await replyToUser(ctx.api, targetId, replied as Message);
          return;
        }
      }
      await ctx.reply("请回复某条转发消息来回复对应用户。");
      return;
    }

    if (!(await isVerified(kv, userId))) {
      await showCaptcha(bot, kv, ctx.chat!.id, userId);
      return;
    }

    await forwardToOwner(ctx.api, ownerId, userId, userName, msg);
    await ctx.reply("✅ 已发送给主人，等待回复...");
  });

  botInstance = bot;
  return bot;
}

// --- Cloudflare Worker entrypoint ---

let lastUpdate: unknown = null;
let lastError: unknown = null;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const ownerId = parseInt(env.OWNER_ID || "0", 10);

    if (request.method !== "POST") {
      let kvOk = false;
      try {
        await env.DM_GATEWAY_KV.put("_health_check", "ok");
        kvOk = (await env.DM_GATEWAY_KV.get("_health_check")) === "ok";
      } catch { kvOk = false; }
      return new Response(JSON.stringify({
        status: "running",
        config: { hasToken: !!env.BOT_TOKEN, ownerId, hasKV: !!env.DM_GATEWAY_KV, kvOk },
        lastUpdate: lastUpdate ? JSON.stringify(lastUpdate).slice(0, 300) : null,
        lastError,
      }, null, 2), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!env.BOT_TOKEN || !ownerId) {
      return new Response("BOT_TOKEN and OWNER_ID are required", { status: 500 });
    }

    try {
      const update = await request.json();
      lastUpdate = update;
      lastError = null;
      const bot = getOrCreateBot(env.BOT_TOKEN, ownerId, env.DM_GATEWAY_KV);
      return await webhookCallback(bot, "cloudflare-mod")(request);
    } catch (e: unknown) {
      const err = e as Error;
      lastError = { message: err.message, stack: err.stack, time: new Date().toISOString() };
      return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 500 });
    }
  },
};
