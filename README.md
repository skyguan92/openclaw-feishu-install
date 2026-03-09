# OpenClaw Channel Installer

[中文](#中文) | [English](#english)

---

## English

**Prerequisite:** You already have [OpenClaw](https://github.com/nicepkg/openclaw) installed and running on your machine.

This installer now supports two channel entry paths:

- **Feishu / Lark**: full Playwright automation for app creation, permissions, event subscriptions, and OpenClaw wiring
- **WeCom / 企业微信**: QR-login automation for the new long-connection intelligent bot mode; it creates the bot, extracts Bot ID / Secret, writes OpenClaw config, and restarts the gateway automatically

Connecting Feishu (Lark) to OpenClaw manually is painful — you need to create an app in the developer console, copy credentials, enable the bot, add 10+ permission scopes one by one, configure event subscriptions, wire everything into OpenClaw's config, restart the gateway, and finally publish. The whole process easily takes **~1 hour** if you're doing it for the first time.

This tool automates the Feishu path end-to-end, and also adds a WeCom entry option for the new long-connection bot mode. Run `npm start`, choose your channel in the web UI, and follow the matching flow. For WeCom, you now only need to provide a bot name and scan the admin QR code once.

It uses Playwright browser automation to drive the Feishu developer console end-to-end, with a local web UI showing real-time progress. The installer now supports macOS, Linux, and Windows.

### How it works

The installer runs through 10 phases automatically:

1. **Login** — Opens the Feishu developer console and waits for you to log in
2. **Create App** — Creates a new enterprise custom app with your chosen name
3. **Extract Credentials** — Retrieves the App ID and App Secret
4. **Enable Bot** — Activates the bot capability on the app
5. **Configure Permissions** — Grants the required API scopes (messages, contacts, etc.)
6. **Configure OpenClaw** — Writes Feishu credentials into the OpenClaw config via CLI
7. **Restart Gateway** — Restarts the OpenClaw gateway to pick up new config
8. **Event Subscriptions** — Configures webhook/WebSocket event callbacks
9. **Publish** — Submits the app for release within your organization
10. **Send First DM** — Calls the Feishu Open API to proactively send the operator a first message

If anything fails mid-way, you can resume from where you left off, rerun from any specific phase, or stop at a chosen phase for modular use.

Notable defaults in the Feishu flow:

- `configure_openclaw` now auto-enables the Feishu plugin and backfills `@larksuiteoapi/node-sdk`. It prefers installing into `extensions/feishu/` and falls back to an isolated temp install + copy if the global OpenClaw package tree is hostile to `npm install`.
- The default is still Feishu `pairing`, so the first private message requires `openclaw pairing approve`.
- After publish, the installer now attempts to message the current operator automatically via `/open-apis/contact/v3/scopes` and `/open-apis/im/v1/messages`, so the user can find the bot entry immediately.
- The UI keeps an explicit "skip first DM pairing" quick mode for personal-only bots. If enabled, it writes `channels.feishu.dmPolicy="open"` plus `allowFrom=["*"]`, so users inside the app's Feishu availability scope can talk to the bot immediately.
- Do not enable that quick mode for shared or enterprise-wide bots unless you deliberately accept the exposure.
- Feishu "available range" is still not automated. After publish, if other members cannot find the bot, add people or departments in "Version Management & Release -> Available Range" and publish again.

### Prerequisites

- **OpenClaw** already installed and running (`openclaw` CLI must be on your `PATH`)
- **Node.js** >= 18
- **Feishu** developer account with admin or app-creation privileges
- **Chromium** (auto-installed via Playwright, or falls back to system Chrome/Edge)

### Quick start

```bash
git clone https://github.com/skyguan92/openclaw-feishu-install.git
cd openclaw-feishu-install
npm install
npx playwright install chromium   # optional — falls back to system Chrome/Edge
npm start
```

On Windows PowerShell, the commands are the same:

```powershell
git clone https://github.com/skyguan92/openclaw-feishu-install.git
cd openclaw-feishu-install
npm install
npx playwright install chromium   # optional — falls back to system Chrome/Edge
npm start
```

The web UI opens at `http://localhost:19090`. In the default flow you only need to enter one OpenClaw name and click **Start Install**. The browser will open for QR login, and the remaining app creation / permission / event / publish / first-message steps are automated.

Windows notes:

- If `openclaw` is installed but not visible in the current `PATH` (common under `schtasks` or SSH sessions), set `OPENCLAW_BIN` to the full CLI path, for example: `C:\\Users\\<you>\\AppData\\Roaming\\npm\\openclaw.cmd`
- If you launch this tool through Windows SSH, the browser may open in a non-interactive session and be invisible to the desktop user. In that case, start it from the desktop session, or run it via `schtasks ... /it`

### Resumable state

Installation state is saved under your home directory:

- macOS / Linux: `~/.openclaw/.feishu-setup-state.json`
- Windows: `%USERPROFILE%\\.openclaw\\.feishu-setup-state.json`

If the process is interrupted, re-running `npm start` will detect the incomplete state and offer to resume or start fresh.

The Web UI and REST API now support:

- resume from the saved breakpoint automatically
- restart from any specific phase (`startPhase`)
- stop after a specific phase (`endPhase`)
- provide an existing `appId` / `appSecret` for mid-pipeline recovery
- clear Feishu login cookies and force a fresh QR-code login

Useful API calls:

```bash
curl -X POST http://localhost:19090/api/start \
  -H 'Content-Type: application/json' \
  -d '{"startPhase":"restart_gateway","endPhase":"post_publish_message"}'

curl -X POST http://localhost:19090/api/reset
curl -X POST http://localhost:19090/api/reset-login
```

### Project structure

```
bin/cli.js              # CLI entry point
src/index.js            # Starts Express server + opens browser
src/server/             # Express app, WebSocket event bus
src/web/                # Frontend (HTML + Tailwind CSS)
src/automation/         # Playwright automation phases
  ├── login.js          # Feishu login flow
  ├── create-app.js     # App creation
  ├── credentials.js    # Credential extraction
  ├── bot.js            # Bot capability setup
  ├── permissions.js    # Permission scope configuration
  ├── events-subscription.js  # Event callback setup
  ├── publish.js        # App publishing
  ├── post-publish-message.js # First DM after publish
  └── runner.js         # Phase orchestrator with state management
src/config/             # OpenClaw CLI integration & gateway management
```

### License

Apache-2.0

---

## 中文

**前提条件：** 你的机器上已经安装并运行了 [OpenClaw](https://github.com/nicepkg/openclaw)。

安装器现在支持两条接入路径：

- **飞书**：继续提供完整的 Playwright 自动化建应用流程
- **企业微信**：新增智能机器人长连接接入；只需要给机器人命名并扫码，安装器会自动创建机器人、提取 Bot ID / Secret、写入 OpenClaw 并重启 Gateway

手动将飞书连接到 OpenClaw 非常繁琐——你需要在开发者后台创建应用、复制凭证、启用机器人能力、逐个添加 10+ 项权限、配置事件订阅、把所有配置写入 OpenClaw、重启 Gateway、最后发布应用。第一次操作至少需要 **~1 小时**。

这个工具把飞书全链路自动化了，同时新增了企业微信长连接接入入口。运行 `npm start` 后，在页面里选择渠道并走对应流程即可。企业微信路径现在不再要求手工填写凭证。

工具使用 Playwright 浏览器自动化驱动飞书开发者后台，配合本地 Web 界面实时展示进度。当前已兼容 macOS、Linux 和 Windows。

### 自动化流程

安装器自动执行 10 个阶段：

1. **登录** — 打开飞书开发者后台，等待用户登录
2. **创建应用** — 使用你指定的名称创建企业自建应用
3. **获取凭证** — 提取 App ID 和 App Secret
4. **启用机器人** — 为应用开启机器人能力
5. **配置权限** — 授予所需的 API 权限（消息、通讯录等）
6. **配置 OpenClaw** — 通过 CLI 将飞书凭证写入 OpenClaw 配置
7. **重启 Gateway** — 重启 OpenClaw Gateway 使新配置生效
8. **事件订阅** — 配置 Webhook/WebSocket 事件回调
9. **发布应用** — 提交应用发布到企业内部
10. **发送首条消息** — 调用飞书 Open API 主动给当前操作者发一条私信

中途失败可以从断点恢复，也可以指定从某个阶段重新开始，或者只执行到某个阶段后暂停，方便模块化使用。

飞书路径的当前默认行为：

- `configure_openclaw` 现在会自动启用飞书插件并补装 `@larksuiteoapi/node-sdk`。它优先在 `extensions/feishu/` 下安装；如果 OpenClaw 全局包目录的 `npm install` 环境很脏，会自动退回到“临时目录隔离安装后复制依赖”的方式。
- 默认仍保留飞书 `pairing`，因此第一次私聊仍需要执行 `openclaw pairing approve`。
- 发布完成后，安装器会额外调用 `/open-apis/contact/v3/scopes` 和 `/open-apis/im/v1/messages`，主动把首条私信发给当前操作者，方便用户马上定位到机器人入口。
- Web UI 保留了显式“跳过首次私聊配对”快速模式；仅当你明确在做个人自用机器人时再勾选。勾选后会写入 `channels.feishu.dmPolicy="open"` 和 `allowFrom=["*"]`，让应用可用范围内的用户第一次私聊就能直接使用。
- 如果你在接入共享机器人或企业内多人可见机器人，不要开启这个快速模式。
- 飞书“可用范围”仍然不能自动化。发布后如果其他成员搜不到机器人，需要到“版本管理与发布 -> 可用范围”里手动加人或部门，再重新发布一次。

### 前置要求

- **OpenClaw** 已安装并运行（`openclaw` CLI 需在 `PATH` 中）
- **Node.js** >= 18
- **飞书**开发者账号，需具备管理员或应用创建权限
- **Chromium**（Playwright 自动安装，或自动回退到系统 Chrome / Edge）

### 快速开始

```bash
git clone https://github.com/skyguan92/openclaw-feishu-install.git
cd openclaw-feishu-install
npm install
npx playwright install chromium   # 可选 — 会自动回退到系统 Chrome / Edge
npm start
```

Windows PowerShell 下命令相同：

```powershell
git clone https://github.com/skyguan92/openclaw-feishu-install.git
cd openclaw-feishu-install
npm install
npx playwright install chromium   # 可选 — 会自动回退到系统 Chrome / Edge
npm start
```

Web 界面在 `http://localhost:19090` 打开。默认只需要填写一个 OpenClaw 名称并点击 **开始自动安装**。浏览器窗口会打开并引导你扫码登录，后续创建应用、权限、事件、OpenClaw 配置、发布和首条消息发送都会自动完成。

Windows 额外说明：

- 如果 `openclaw` 已安装但当前会话找不到它（常见于 `schtasks` 或 SSH 会话），可以设置 `OPENCLAW_BIN` 指向完整路径，例如：`C:\\Users\\<你>\\AppData\\Roaming\\npm\\openclaw.cmd`
- 如果你是通过 Windows SSH 启动本工具，浏览器可能会开在非交互式 session，桌面用户看不到窗口。这种情况下请直接在桌面会话运行，或改用 `schtasks ... /it`

### 断点恢复

安装状态保存在当前用户主目录下：

- macOS / Linux：`~/.openclaw/.feishu-setup-state.json`
- Windows：`%USERPROFILE%\\.openclaw\\.feishu-setup-state.json`

如果流程中断，重新运行 `npm start` 会检测到未完成状态，可以选择继续安装或重新开始。

现在 Web UI 和 REST API 还支持：

- 自动从断点继续
- 指定从某个阶段开始执行（`startPhase`）
- 指定执行到某个阶段即停止（`endPhase`）
- 在中途恢复时直接填写已有 `appId` / `appSecret`
- 清空飞书登录 cookies，强制重新扫码登录

常用 API：

```bash
curl -X POST http://localhost:19090/api/start \
  -H 'Content-Type: application/json' \
  -d '{"startPhase":"restart_gateway","endPhase":"post_publish_message"}'

curl -X POST http://localhost:19090/api/reset
curl -X POST http://localhost:19090/api/reset-login
```

### 项目结构

```
bin/cli.js              # CLI 入口
src/index.js            # 启动 Express 服务 + 打开浏览器
src/server/             # Express 应用、WebSocket 事件总线
src/web/                # 前端界面（HTML + Tailwind CSS）
src/automation/         # Playwright 自动化各阶段
  ├── login.js          # 飞书登录流程
  ├── create-app.js     # 应用创建
  ├── credentials.js    # 凭证提取
  ├── bot.js            # 机器人能力设置
  ├── permissions.js    # 权限范围配置
  ├── events-subscription.js  # 事件回调配置
  ├── publish.js        # 应用发布
  ├── post-publish-message.js # 发布后发送首条私信
  └── runner.js         # 阶段编排器（含状态管理）
src/config/             # OpenClaw CLI 集成 & Gateway 管理
```

### 开源协议

Apache-2.0
