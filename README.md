# OpenClaw Feishu Installer

[中文](#中文) | [English](#english)

---

## English

**Prerequisite:** You already have [OpenClaw](https://github.com/nicepkg/openclaw) installed and running on your machine.

Connecting Feishu (Lark) to OpenClaw manually is painful — you need to create an app in the developer console, copy credentials, enable the bot, add 10+ permission scopes one by one, configure event subscriptions, wire everything into OpenClaw's config, restart the gateway, and finally publish. The whole process easily takes **~1 hour** if you're doing it for the first time.

This tool automates all of it. Just run `npm start`, log into Feishu, and **everything is done in ~5 minutes**.

It uses Playwright browser automation to drive the Feishu developer console end-to-end, with a local web UI showing real-time progress.

### How it works

The installer runs through 9 phases automatically:

1. **Login** — Opens the Feishu developer console and waits for you to log in
2. **Create App** — Creates a new enterprise custom app with your chosen name
3. **Extract Credentials** — Retrieves the App ID and App Secret
4. **Enable Bot** — Activates the bot capability on the app
5. **Configure Permissions** — Grants the required API scopes (messages, contacts, etc.)
6. **Configure OpenClaw** — Writes Feishu credentials into the OpenClaw config via CLI
7. **Restart Gateway** — Restarts the OpenClaw gateway to pick up new config
8. **Event Subscriptions** — Configures webhook/WebSocket event callbacks
9. **Publish** — Submits the app for release within your organization

If anything fails mid-way, you can resume from where you left off — no need to start over.

### Prerequisites

- **OpenClaw** already installed and running (`openclaw` CLI must be on your `PATH`)
- **Node.js** >= 18
- **Feishu** developer account with admin or app-creation privileges
- **Chromium** (auto-installed via Playwright, or falls back to system Chrome)

### Quick start

```bash
git clone https://github.com/skyguan92/openclaw-feishu-install.git
cd openclaw-feishu-install
npm install
npx playwright install chromium   # optional — falls back to system Chrome
npm start
```

The web UI opens at `http://localhost:19090`. Fill in the app name and bot name, then click **Start Install**. A Chromium window will open for you to log into Feishu — after that, everything is automated.

### Resumable state

Installation state is saved to `~/.openclaw/.feishu-setup-state.json`. If the process is interrupted, re-running `npm start` will detect the incomplete state and offer to resume or start fresh.

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
  └── runner.js         # Phase orchestrator with state management
src/config/             # OpenClaw CLI integration & gateway management
```

### License

MIT

---

## 中文

**前提条件：** 你的机器上已经安装并运行了 [OpenClaw](https://github.com/nicepkg/openclaw)。

手动将飞书连接到 OpenClaw 非常繁琐——你需要在开发者后台创建应用、复制凭证、启用机器人能力、逐个添加 10+ 项权限、配置事件订阅、把所有配置写入 OpenClaw、重启 Gateway、最后发布应用。第一次操作至少需要 **~1 小时**。

这个工具把全部流程自动化了。运行 `npm start`，登录飞书，**5 分钟内全部搞定**。

工具使用 Playwright 浏览器自动化驱动飞书开发者后台，配合本地 Web 界面实时展示进度。

### 自动化流程

安装器自动执行 9 个阶段：

1. **登录** — 打开飞书开发者后台，等待用户登录
2. **创建应用** — 使用你指定的名称创建企业自建应用
3. **获取凭证** — 提取 App ID 和 App Secret
4. **启用机器人** — 为应用开启机器人能力
5. **配置权限** — 授予所需的 API 权限（消息、通讯录等）
6. **配置 OpenClaw** — 通过 CLI 将飞书凭证写入 OpenClaw 配置
7. **重启 Gateway** — 重启 OpenClaw Gateway 使新配置生效
8. **事件订阅** — 配置 Webhook/WebSocket 事件回调
9. **发布应用** — 提交应用发布到企业内部

中途失败可以从断点恢复，无需从头开始。

### 前置要求

- **OpenClaw** 已安装并运行（`openclaw` CLI 需在 `PATH` 中）
- **Node.js** >= 18
- **飞书**开发者账号，需具备管理员或应用创建权限
- **Chromium**（Playwright 自动安装，或自动回退到系统 Chrome）

### 快速开始

```bash
git clone https://github.com/skyguan92/openclaw-feishu-install.git
cd openclaw-feishu-install
npm install
npx playwright install chromium   # 可选 — 会自动回退到系统 Chrome
npm start
```

Web 界面在 `http://localhost:19090` 打开。填写应用名称和机器人名称，点击 **开始安装**。浏览器窗口会打开并引导你登录飞书，登录后全部流程自动完成。

### 断点恢复

安装状态保存在 `~/.openclaw/.feishu-setup-state.json`。如果流程中断，重新运行 `npm start` 会检测到未完成状态，可以选择继续安装或重新开始。

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
  └── runner.js         # 阶段编排器（含状态管理）
src/config/             # OpenClaw CLI 集成 & Gateway 管理
```

### 开源协议

MIT
