# DM Gateway Bot — Cloudflare Workers

Telegram 私聊中转机器人。**可直接粘贴到 Cloudflare 网页控制台部署**，无需本地命令行。

## 功能

- **文字问答验证** — 随机中文常识题（含数学题），6 选 1 正确即通过
- **答错锁定** — 答错 1 次锁定 3 分钟，防止脚本暴力破解
- **验证过期** — 通过后 72 小时（3 天）自动失效，需重新验证
- **主人撤销** — 主人发送 `/unverify <用户ID>` 可手动撤销某人的验证
- **命令菜单** — 输入 `/` 弹出命令列表（需注册，见第五步）
- **消息中转** — 验证通过后消息自动转发给主人，支持文字/图片/视频/文件/贴纸等
- **主人回复** — 主人回复转发消息，内容自动送达对应用户
- **持久化存储** — Cloudflare KV 存储，重启不丢失

## 命令

| 命令 | 说明 |
|------|------|
| `/start` | 开始验证 / 查看验证状态 |
| `/status` | 查看验证状态和剩余时间 |
| `/unverify <ID>` | 撤销用户验证（仅主人） |

---

## 网页端部署（无需本地环境）

### 第一步：创建 KV 命名空间

1. 打开 [Cloudflare Dashboard](https://dash.cloudflare.com) → **Workers & Pages** → **KV**
2. 点击 **Create namespace**
3. 名称填 `DM_GATEWAY_KV`，点击 **Add**

### 第二步：创建 Worker

1. 进入 **Workers & Pages** → **Create application** → **Create Worker**
2. 随便起个名字（比如 `dm-gateway-bot`），点击 **Deploy**（先部署默认代码）
3. 部署后点击 **Edit code**，删掉编辑器里所有默认代码
4. 把 **`worker-standalone.js`**（零依赖版本，推荐）的全部内容粘贴进去
5. 点击右上角 **Save and Deploy**

### 第三步：绑定 KV

1. 在 Worker 详情页 → **Settings** → **Variables**
2. **KV Namespace Bindings** → **Add binding**
3. Variable name 填 `DM_GATEWAY_KV`，选择刚才创建的 namespace
4. 保存

### 第四步：添加 Secrets

1. 同样在 **Settings** → **Variables** 页面
2. **Secrets** → **Add secret**
3. 分别添加两个 Secret：

| Name | Value |
|------|-------|
| `BOT_TOKEN` | 你的 Telegram Bot Token（从 @BotFather 获取） |
| `OWNER_ID` | 你的 Telegram 用户 ID（纯数字，向 @userinfobot 获取） |

### 第五步：设置 Webhook & 注册命令

设置 Webhook（替换 TOKEN 和 WORKER_URL）：
```
https://api.telegram.org/bot<TOKEN>/setWebhook?url=<WORKER_URL>
```

注册命令菜单（输入 `/` 时弹出）：
```
https://api.telegram.org/bot<TOKEN>/setMyCommands?commands=[{"command":"start","description":"开始验证"},{"command":"status","description":"查看验证状态"},{"command":"unverify","description":"撤销用户验证（仅主人）"}]
```

### 第六步：测试

私聊你的 Bot，发送 `/start`，回答验证问题即可。

---

## 本地部署（wrangler CLI）

如果你想用 TypeScript 源码，通过 wrangler CLI 部署：

```bash
cd dm-gateway-bot-cf
npm install

# 创建 KV 命名空间
npx wrangler kv:namespace create DM_GATEWAY_KV
# 将输出的 id 填入 wrangler.toml 的 kv_namespaces

# 设置密钥
npx wrangler secret put BOT_TOKEN
npx wrangler secret put OWNER_ID

# 部署
npm run deploy
```

部署后同样需要设置 Webhook（见第五步）。

---

## 配置说明

| 变量 | 必填 | 说明 |
|------|------|------|
| `BOT_TOKEN` | ✅ | Telegram Bot Token，从 @BotFather 获取 |
| `OWNER_ID` | ✅ | 主人的 Telegram 用户 ID（纯数字） |

## 可调参数（在代码顶部修改）

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `FAIL_MAX` | 1 | 答错多少次锁定 |
| `LOCK_SECONDS` | 180 | 锁定时长（秒） |
| `VERIFY_TTL_HOURS` | 72 | 验证有效期（小时） |

---

## 项目文件

```
dm-gateway-bot-cf/
├── worker-standalone.js   ← 网页部署用（零依赖，推荐）
├── src/index.ts           ← TypeScript 源码（wrangler CLI 本地部署用）
├── wrangler.toml           ← wrangler CLI 配置
├── package.json
├── tsconfig.json
└── README.md
```

## License

MIT
