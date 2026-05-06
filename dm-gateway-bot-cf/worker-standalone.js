/**
 * DM Gateway Bot — Cloudflare Workers（零依赖版本）
 * 不依赖任何 npm 包，直接调用 Telegram Bot API。
 * 可直接粘贴到 Cloudflare Dashboard 网页编辑器部署。
 */

// ============================================================
// 配置：在 Cloudflare Dashboard 的 Settings → Variables 中设置
// Secret:  BOT_TOKEN  — Telegram Bot Token（从 @BotFather 获取）
// Secret:  OWNER_ID   — 你的 Telegram 数字 ID
// KV:      DM_GATEWAY_KV — 创建 KV namespace 后绑定
// ============================================================

// 文字验证题库：每个问题有 6 个选项，答对算通过
const QUESTIONS = [
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

const FAIL_MAX = 1;        // 答错即锁定
const LOCK_SECONDS = 180;  // 锁定 3 分钟
const VERIFY_TTL_HOURS = 72; // 验证通过后 72 小时自动过期

// --- Telegram API 工具函数 ---

const API = (token) => `https://api.telegram.org/bot${token}`;

async function tg(env, method, body) {
  const url = `${API(env.BOT_TOKEN)}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) {
    console.error(`[tg] ${method} FAILED:`, JSON.stringify({ body, response: data }));
  } else {
    console.log(`[tg] ${method} OK`);
  }
  return data;
}

// --- 工具函数 ---

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildCaptchaKeyboard(options) {
  const row = options.map((opt) => ({
    text: opt,
    callback_data: `verify:${opt}`,
  }));
  return { inline_keyboard: [row.slice(0, 3), row.slice(3, 6)] };
}

function extractUserId(text) {
  const m = text.match(/用户 ID:\s*(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

// --- KV helpers ---

async function isVerified(kv, userId) {
  const v = await kv.get(`verified:${userId}`);
  if (!v) return false;
  const verifiedAt = parseInt(v, 10);
  const elapsed = (Date.now() - verifiedAt) / 1000 / 3600; // 小时
  return elapsed < VERIFY_TTL_HOURS;
}

async function addVerified(kv, userId) {
  const ts = String(Date.now());
  await kv.put(`verified:${userId}`, ts, { expirationTtl: VERIFY_TTL_HOURS * 3600 + 600 });
}

async function getVerifiedTime(kv, userId) {
  const v = await kv.get(`verified:${userId}`);
  return v ? parseInt(v, 10) : null;
}

async function removeVerified(kv, userId) {
  await kv.delete(`verified:${userId}`);
}

async function getPending(kv, userId) {
  return kv.get(`pending:${userId}`);
}

async function setPending(kv, userId, answer) {
  await kv.put(`pending:${userId}`, answer, { expirationTtl: 300 });
}

async function deletePending(kv, userId) {
  await kv.delete(`pending:${userId}`);
}

async function getFailCount(kv, userId) {
  const v = await kv.get(`fail:${userId}`);
  return v ? parseInt(v, 10) : 0;
}

async function incrementFailCount(kv, userId) {
  const count = await getFailCount(kv, userId) + 1;
  await kv.put(`fail:${userId}`, String(count), { expirationTtl: 3600 });
  return count;
}

async function resetFailCount(kv, userId) {
  await kv.delete(`fail:${userId}`);
}

async function lockUser(kv, userId) {
  const expiresAt = Date.now() + LOCK_SECONDS * 1000;
  await kv.put(`lock:${userId}`, String(expiresAt), { expirationTtl: LOCK_SECONDS + 10 });
}

async function getLockRemaining(kv, userId) {
  const v = await kv.get(`lock:${userId}`);
  if (!v) return 0;
  const remaining = Math.ceil((parseInt(v, 10) - Date.now()) / 1000);
  return remaining > 0 ? remaining : 0;
}

// --- 消息转发 ---

async function forwardToOwner(env, ownerId, userId, userName, msg) {
  const header = `💬 来自 ${userName} 的消息：\n用户 ID: ${userId}\n`;
  const suffix = `\n\n用户 ID: ${userId}`;

  if (msg.text) {
    await tg(env, "sendMessage", { chat_id: ownerId, text: `${header}\n${msg.text}` });
  } else if (msg.sticker) {
    await tg(env, "sendMessage", { chat_id: ownerId, text: header });
    await tg(env, "sendSticker", { chat_id: ownerId, sticker: msg.sticker.file_id });
  } else if (msg.photo) {
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    await tg(env, "sendPhoto", { chat_id: ownerId, photo: fileId, caption: `${header}${(msg.caption || "") + suffix}` });
  } else if (msg.video) {
    await tg(env, "sendVideo", { chat_id: ownerId, video: msg.video.file_id, caption: `${header}${(msg.caption || "") + suffix}` });
  } else if (msg.video_note) {
    await tg(env, "sendMessage", { chat_id: ownerId, text: header });
    await tg(env, "sendVideoNote", { chat_id: ownerId, video_note: msg.video_note.file_id });
  } else if (msg.voice) {
    await tg(env, "sendVoice", { chat_id: ownerId, voice: msg.voice.file_id, caption: `${header}${(msg.caption || "") + suffix}` });
  } else if (msg.audio) {
    await tg(env, "sendAudio", { chat_id: ownerId, audio: msg.audio.file_id, caption: `${header}${(msg.caption || "") + suffix}` });
  } else if (msg.document) {
    await tg(env, "sendDocument", { chat_id: ownerId, document: msg.document.file_id, caption: `${header}${(msg.caption || "") + suffix}` });
  } else if (msg.animation) {
    await tg(env, "sendAnimation", { chat_id: ownerId, animation: msg.animation.file_id, caption: `${header}${(msg.caption || "") + suffix}` });
  } else if (msg.location) {
    await tg(env, "sendMessage", { chat_id: ownerId, text: header });
    await tg(env, "sendLocation", { chat_id: ownerId, latitude: msg.location.latitude, longitude: msg.location.longitude });
  } else if (msg.contact) {
    await tg(env, "sendMessage", { chat_id: ownerId, text: header });
    await tg(env, "sendContact", { chat_id: ownerId, phone_number: msg.contact.phone_number, first_name: msg.contact.first_name, last_name: msg.contact.last_name || "" });
  } else {
    await tg(env, "sendMessage", { chat_id: ownerId, text: header });
    await tg(env, "forwardMessage", { chat_id: ownerId, from_chat_id: msg.chat.id, message_id: msg.message_id });
  }
}

async function replyToUser(env, targetId, msg) {
  const prefix = "💬 主人回复：\n";

  if (msg.text) {
    await tg(env, "sendMessage", { chat_id: targetId, text: `${prefix}${msg.text}` });
  } else if (msg.sticker) {
    await tg(env, "sendSticker", { chat_id: targetId, sticker: msg.sticker.file_id });
  } else if (msg.photo) {
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    await tg(env, "sendPhoto", { chat_id: targetId, photo: fileId, caption: msg.caption || "" });
  } else if (msg.video) {
    await tg(env, "sendVideo", { chat_id: targetId, video: msg.video.file_id, caption: msg.caption || "" });
  } else if (msg.video_note) {
    await tg(env, "sendVideoNote", { chat_id: targetId, video_note: msg.video_note.file_id });
  } else if (msg.voice) {
    await tg(env, "sendVoice", { chat_id: targetId, voice: msg.voice.file_id, caption: msg.caption || "" });
  } else if (msg.audio) {
    await tg(env, "sendAudio", { chat_id: targetId, audio: msg.audio.file_id, caption: msg.caption || "" });
  } else if (msg.document) {
    await tg(env, "sendDocument", { chat_id: targetId, document: msg.document.file_id, caption: msg.caption || "" });
  } else if (msg.animation) {
    await tg(env, "sendAnimation", { chat_id: targetId, animation: msg.animation.file_id, caption: msg.caption || "" });
  } else if (msg.location) {
    await tg(env, "sendLocation", { chat_id: targetId, latitude: msg.location.latitude, longitude: msg.location.longitude });
  } else {
    await tg(env, "forwardMessage", { chat_id: targetId, from_chat_id: msg.chat.id, message_id: msg.message_id });
  }
}

async function setupCommands(env) {
  await tg(env, "setMyCommands", {
    commands: [
      { command: "start", description: "开始验证 / 查看状态" },
      { command: "status", description: "查看验证状态和剩余时间" },
      { command: "unverify", description: "撤销用户验证（仅主人）" },
    ],
  });
}

async function showCaptcha(env, kv, userId) {
  // 检查是否被锁定
  const remaining = await getLockRemaining(kv, userId);
  if (remaining > 0) {
    await tg(env, "sendMessage", {
      chat_id: userId,
      text: `🚫 验证失败次数过多，请等待 ${remaining} 秒后再试。`,
    });
    return;
  }

  const pick = QUESTIONS[Math.floor(Math.random() * QUESTIONS.length)];
  const options = shuffle(pick.opts);
  const failCount = await getFailCount(kv, userId);
  const attemptsLeft = FAIL_MAX - failCount;

  await setPending(kv, userId, pick.ans);
  await tg(env, "sendMessage", {
    chat_id: userId,
    text: `🤖 你想联系主人，请先验证你是真人：\n\n❓ ${pick.q}\n\n剩余尝试次数：${attemptsLeft}`,
    reply_markup: buildCaptchaKeyboard(options),
  });
}

// --- 处理单个 Telegram Update ---

async function handleUpdate(env, update) {
  const ownerId = parseInt(env.OWNER_ID, 10);
  const kv = env.DM_GATEWAY_KV;

  console.log("[update]", JSON.stringify({ update_id: update.update_id, type: update.callback_query ? "callback" : update.message ? "message" : "other" }));

  // --- Callback query（用户点击验证按钮） ---
  if (update.callback_query) {
    const cq = update.callback_query;
    const userId = cq.from.id;
    const data = cq.data;

    console.log("[callback]", JSON.stringify({ userId, data }));

    if (!data.startsWith("verify:")) return;

    const selected = data.slice(7);
    const correct = await getPending(kv, userId);
    console.log("[captcha]", JSON.stringify({ userId, selected, correct }));

    if (!correct) {
      await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "验证已超时，请重新发送 /start", show_alert: true });
      await tg(env, "editMessageText", { chat_id: cq.message.chat.id, message_id: cq.message.message_id, text: "验证已超时，请重新发送 /start" });
      return;
    }

    if (selected === correct) {
      await resetFailCount(kv, userId);
      await addVerified(kv, userId);
      await deletePending(kv, userId);
      await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "🎉 验证通过！" });
      await tg(env, "editMessageText", { chat_id: cq.message.chat.id, message_id: cq.message.message_id, text: `✅ 验证通过！你的消息将转达给主人。主人回复后你会收到通知。\n\n⏰ 验证有效期 ${VERIFY_TTL_HOURS / 24} 天，过期需重新验证。` });
    } else {
      const failCount = await incrementFailCount(kv, userId);
      if (failCount >= FAIL_MAX) {
        await lockUser(kv, userId);
        await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "❌ 验证失败，已锁定 3 分钟", show_alert: true });
        await tg(env, "editMessageText", { chat_id: cq.message.chat.id, message_id: cq.message.message_id, text: `🚫 验证失败！你已被锁定 ${LOCK_SECONDS / 60} 分钟，请稍后再试。` });
        await deletePending(kv, userId);
      } else {
        const left = FAIL_MAX - failCount;
        await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: `❌ 选择错误，还剩 ${left} 次机会`, show_alert: true });
        // 换一道新题
        const pick = QUESTIONS[Math.floor(Math.random() * QUESTIONS.length)];
        const options = shuffle(pick.opts);
        await setPending(kv, userId, pick.ans);
        await tg(env, "editMessageText", {
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          text: `🤖 请先验证你是真人：\n\n❓ ${pick.q}\n\n剩余尝试次数：${left}`,
          reply_markup: buildCaptchaKeyboard(options),
        });
      }
    }
    return;
  }

  // --- Message ---
  const msg = update.message;
  if (!msg) return;

  const userId = msg.from.id;
  const userName = msg.from.first_name || "未知";

  console.log("[msg]", JSON.stringify({ userId, userName, text: msg.text?.slice(0, 50), isOwner: userId === ownerId }));

  // 命令处理
  if (msg.text) {
    // --- /unverify（仅主人可用） ---
    if (msg.text.startsWith("/unverify") && userId === ownerId) {
      const parts = msg.text.split(/\s+/);
      const targetId = parts[1] ? parseInt(parts[1], 10) : null;
      if (!targetId) {
        await tg(env, "sendMessage", { chat_id: userId, text: "用法：/unverify <用户ID>\n\n用户 ID 可以从转发消息头部获取。" });
        return;
      }
      await removeVerified(kv, targetId);
      await tg(env, "sendMessage", { chat_id: userId, text: `✅ 已将用户 ${targetId} 的验证状态重置。` });
      await tg(env, "sendMessage", { chat_id: targetId, text: "⚠️ 你的验证已过期，请重新发送 /start 完成验证。" });
      return;
    }

    if (msg.text.startsWith("/start")) {
      console.log("[cmd] /start", JSON.stringify({ userId, isOwner: userId === ownerId }));
      if (userId === ownerId) {
        await tg(env, "sendMessage", { chat_id: userId, text: "你是管理员，可以直接发消息给我，我会帮你转发。\n\n命令：\n/unverify <用户ID> — 撤销用户验证" });
        return;
      }
      const verified = await isVerified(kv, userId);
      if (verified) {
        const vt = await getVerifiedTime(kv, userId);
        const remain = vt ? Math.max(0, Math.ceil(VERIFY_TTL_HOURS - (Date.now() - vt) / 1000 / 3600)) : 0;
        await tg(env, "sendMessage", { chat_id: userId, text: `你已经通过验证，直接发消息给我即可转达给主人。\n\n⏰ 验证剩余 ${remain} 小时` });
        return;
      }
      await showCaptcha(env, kv, userId);
      return;
    }

    // --- /status 查看验证状态 ---
    if (msg.text.startsWith("/status")) {
      const verified = await isVerified(kv, userId);
      if (verified) {
        const vt = await getVerifiedTime(kv, userId);
        const remain = vt ? Math.max(0, Math.ceil(VERIFY_TTL_HOURS - (Date.now() - vt) / 1000 / 3600)) : 0;
        await tg(env, "sendMessage", { chat_id: userId, text: `✅ 已验证\n⏰ 剩余 ${remain} 小时\n📋 用户 ID: ${userId}` });
      } else {
        const locked = await getLockRemaining(kv, userId);
        if (locked > 0) {
          await tg(env, "sendMessage", { chat_id: userId, text: `🚫 已锁定，请等待 ${locked} 秒` });
        } else {
          await tg(env, "sendMessage", { chat_id: userId, text: "❌ 未验证，请发送 /start 完成验证。" });
        }
      }
      return;
    }

    // 忽略其他命令
    if (msg.text.startsWith("/")) return;
  }

  // --- Owner 消息 ---
  if (userId === ownerId) {
    const replied = msg.reply_to_message;
    if (replied) {
      const sourceText = replied.text || replied.caption || "";
      const targetId = extractUserId(sourceText);
      if (targetId) {
        await replyToUser(env, targetId, msg);
        return;
      }
    }
    await tg(env, "sendMessage", { chat_id: userId, text: "请回复某条转发消息来回复对应用户。" });
    return;
  }

  // --- 未验证用户 ---
  if (!(await isVerified(kv, userId))) {
    await showCaptcha(env, kv, userId);
    return;
  }

  // --- 已验证用户，转发给主人 ---
  await forwardToOwner(env, ownerId, userId, userName, msg);
  await tg(env, "sendMessage", { chat_id: userId, text: "✅ 已发送给主人，等待回复..." });
}

// --- Worker 入口 ---

let lastUpdate = null;
let lastError = null;

export default {
  async fetch(request, env) {
    // GET 请求：注册 Bot 命令 + 返回诊断信息
    if (request.method !== "POST") {
      await setupCommands(env);
      const ownerId = parseInt(env.OWNER_ID || "0", 10);
      const hasToken = !!env.BOT_TOKEN;
      const hasKV = !!env.DM_GATEWAY_KV;
      // 测试 KV 读写
      let kvOk = false;
      try {
        await env.DM_GATEWAY_KV.put("_health_check", "ok");
        kvOk = (await env.DM_GATEWAY_KV.get("_health_check")) === "ok";
      } catch (e) {
        kvOk = false;
      }
      return new Response(JSON.stringify({
        status: "running",
        config: { hasToken, ownerId, hasKV, kvOk },
        lastUpdate: lastUpdate ? JSON.stringify(lastUpdate).slice(0, 300) : null,
        lastError,
      }, null, 2), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const ownerId = parseInt(env.OWNER_ID || "0", 10);
    if (!env.BOT_TOKEN || !ownerId) {
      return new Response("BOT_TOKEN and OWNER_ID must be set in Cloudflare Secrets", { status: 500 });
    }

    try {
      const update = await request.json();
      lastUpdate = update;
      lastError = null;
      console.log("[raw]", JSON.stringify(update).slice(0, 500));
      await handleUpdate(env, update);
    } catch (e) {
      lastError = { message: e.message, stack: e.stack, time: new Date().toISOString() };
      console.error("[error]", e.message, e.stack);
      return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500 });
    }

    return new Response("ok");
  },
};
