const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { waitForLogin } = require('./login');
const { createApp } = require('./create-app');
const { extractCredentials } = require('./credentials');
const { enableBot } = require('./bot');
const { configurePermissions } = require('./permissions');
const { configureEvents } = require('./events-subscription');
const { publishApp } = require('./publish');
const openclawConfig = require('../config/openclaw');
const gatewayConfig = require('../config/gateway');
const { dismissModals } = require('./dismiss-modals');
const { findSystemBrowserExecutable } = require('../utils/browser');
const {
  BROWSER_PROFILE_DIR,
  SCREENSHOT_DIR,
  STATE_FILE,
} = require('../utils/paths');
const {
  getWindowsInteractiveTaskCommand,
  isLikelyWindowsSshSession,
} = require('../utils/runtime-context');

const PHASES = [
  'login',
  'create_app',
  'credentials',
  'bot',
  'permissions',
  'configure_openclaw',
  'restart_gateway',
  'events',
  'publish',
];

const BROWSER_PROFILE_LOCK_FILES = [
  'SingletonLock',
  'SingletonCookie',
  'SingletonSocket',
  'lockfile',
];

function isProfileLockError(err) {
  const message = String(err && err.message ? err.message : err).toLowerCase();
  return message.includes('singleton')
    || message.includes('lock')
    || message.includes('user data directory is already in use');
}

function clearBrowserProfileLocks(profileDir) {
  const removed = [];

  for (const fileName of BROWSER_PROFILE_LOCK_FILES) {
    const filePath = path.join(profileDir, fileName);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        removed.push(fileName);
      }
    } catch {
      // ignore cleanup failure and continue
    }
  }

  return removed;
}

async function launchPersistentContext(launchOptions, bus) {
  try {
    return await chromium.launchPersistentContext(BROWSER_PROFILE_DIR, launchOptions);
  } catch (err) {
    if (!isProfileLockError(err)) {
      throw err;
    }

    const removedLocks = clearBrowserProfileLocks(BROWSER_PROFILE_DIR);
    if (!removedLocks.length) {
      throw err;
    }

    bus.sendLog(`检测到浏览器 profile 锁文件，已清理后重试: ${removedLocks.join(', ')}`);
    return chromium.launchPersistentContext(BROWSER_PROFILE_DIR, launchOptions);
  }
}

class Runner {
  constructor(bus, options) {
    this.bus = bus;
    this.options = options;
    this.running = false;
    this.cancelled = false;
    this.browser = null;
    this.page = null;
    this.currentPhase = null;
    this.state = this.loadState();
  }

  loadState() {
    try {
      if (fs.existsSync(STATE_FILE)) {
        return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      }
    } catch {
      // corrupted state
    }
    return { completedPhases: [], appId: null, appSecret: null };
  }

  saveState() {
    const dir = path.dirname(STATE_FILE);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2));
  }

  clearState() {
    try {
      fs.unlinkSync(STATE_FILE);
    } catch {
      // file may not exist
    }
  }

  isPhaseCompleted(phase) {
    return this.state.completedPhases.includes(phase);
  }

  completePhase(phase) {
    if (!this.state.completedPhases.includes(phase)) {
      this.state.completedPhases.push(phase);
    }
    this.state.currentPhase = phase;
    this.saveState();
  }

  async takeScreenshot(name) {
    if (!this.page) return;
    try {
      fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
      const filePath = path.join(SCREENSHOT_DIR, `${name}-${Date.now()}.png`);
      await this.page.screenshot({ path: filePath, fullPage: true });
      this.bus.sendLog(`截图已保存: ${filePath}`);
    } catch {
      // screenshot failed
    }
  }

  async run() {
    this.running = true;
    this.cancelled = false;

    try {
      // Launch headed Playwright browser
      this.bus.sendLog('启动 Playwright 浏览器...');

      if (isLikelyWindowsSshSession()) {
        this.bus.sendLog('检测到 Windows SSH 会话，浏览器窗口可能不会显示在用户桌面上。');
        this.bus.sendLog(`如果用户看不到浏览器，请在桌面会话运行，或执行: ${getWindowsInteractiveTaskCommand()}`);
      }

      // Keep a persistent browser profile so Feishu login can be reused.
      const launchOptions = {
        headless: false,
        args: ['--disable-blink-features=AutomationControlled'],
        viewport: { width: 1280, height: 900 },
        locale: 'zh-CN',
      };
      try {
        this.browser = await launchPersistentContext(launchOptions, this.bus);
      } catch {
        this.bus.sendLog('Playwright 自带浏览器未安装，尝试使用系统 Chrome / Edge...');
        const systemBrowserPath = findSystemBrowserExecutable();
        if (!systemBrowserPath) {
          throw new Error(
            '未找到可用浏览器。请运行 npx playwright install chromium，或安装 Google Chrome / Microsoft Edge'
          );
        }

        launchOptions.executablePath = systemBrowserPath;
        this.browser = await launchPersistentContext(launchOptions, this.bus);
        this.bus.sendLog(`使用系统浏览器: ${systemBrowserPath}`);
      }

      this.bus.sendLog(`使用持久化浏览器目录: ${BROWSER_PROFILE_DIR}`);
      const context = this.browser;
      this.page = context.pages()[0] || await context.newPage();

      // Auto-dismiss upgrade guide / announcement modals that block interaction
      this._dismissInterval = setInterval(async () => {
        try {
          if (!this.page || this.page.isClosed()) return;
          await dismissModals(this.page, this.bus);
        } catch {}
      }, 2000);

      // Phase 1: Login
      // Always verify login session — a fresh browser has no cookies,
      // so even if login was "completed" previously, we may need to re-login.
      // Let waitForLogin handle all navigation (single goto, no double-refresh).
      this.currentPhase = 'login';
      await waitForLogin(this.page, this.bus);
      if (!this.isPhaseCompleted('login')) {
        this.completePhase('login');
      }

      if (this.cancelled) return;

      // Phase 2: Create App
      if (!this.isPhaseCompleted('create_app')) {
        this.currentPhase = 'create_app';
        const appId = await createApp(this.page, this.bus, this.options);
        this.state.appId = appId;
        this.state.feishuAppUrl = `https://open.feishu.cn/app/${appId}`;
        this.completePhase('create_app');
      } else {
        this.bus.sendPhase('create_app', 'skipped', `应用已创建: ${this.state.appId}`);
      }

      if (this.cancelled) return;

      // Phase 3: Get Credentials
      if (!this.isPhaseCompleted('credentials')) {
        this.currentPhase = 'credentials';
        const creds = await extractCredentials(this.page, this.bus, this.state.appId);
        this.state.appSecret = creds.appSecret;
        this.completePhase('credentials');
      } else {
        this.bus.sendPhase('credentials', 'skipped', '凭证已获取');
      }

      if (this.cancelled) return;

      // Phase 4: Enable Bot
      if (!this.isPhaseCompleted('bot')) {
        this.currentPhase = 'bot';
        await enableBot(this.page, this.bus, this.state.appId, this.options.botName);
        this.completePhase('bot');
      } else {
        this.bus.sendPhase('bot', 'skipped', '机器人已启用');
      }

      if (this.cancelled) return;

      // Phase 5: Configure Permissions
      if (!this.isPhaseCompleted('permissions')) {
        this.currentPhase = 'permissions';
        await configurePermissions(this.page, this.bus, this.state.appId);
        this.completePhase('permissions');
      } else {
        this.bus.sendPhase('permissions', 'skipped', '权限已配置');
      }

      if (this.cancelled) return;

      // Phase 6: Configure OpenClaw
      if (!this.isPhaseCompleted('configure_openclaw')) {
        this.currentPhase = 'configure_openclaw';
        this.bus.sendPhase('configure_openclaw', 'running', '正在配置 OpenClaw...');
        await openclawConfig.configureOpenClaw(
          this.bus,
          this.state.appId,
          this.state.appSecret,
          { botName: this.options.botName }
        );
        this.completePhase('configure_openclaw');
        this.bus.sendPhase('configure_openclaw', 'done', 'OpenClaw 配置完成');
      } else {
        this.bus.sendPhase('configure_openclaw', 'skipped', 'OpenClaw 已配置');
      }

      if (this.cancelled) return;

      // Phase 7: Restart Gateway
      if (!this.isPhaseCompleted('restart_gateway')) {
        this.currentPhase = 'restart_gateway';
        this.bus.sendPhase('restart_gateway', 'running', '正在重启 Gateway...');
        await gatewayConfig.restartGateway(this.bus);
        this.completePhase('restart_gateway');
        this.bus.sendPhase('restart_gateway', 'done', 'Gateway 重启成功');
      } else {
        this.bus.sendPhase('restart_gateway', 'skipped', 'Gateway 已就绪');
      }

      if (this.cancelled) return;

      // Phase 8: Configure Events
      if (!this.isPhaseCompleted('events')) {
        this.currentPhase = 'events';
        await configureEvents(this.page, this.bus, this.state.appId);
        this.completePhase('events');
      } else {
        this.bus.sendPhase('events', 'skipped', '事件订阅已配置');
      }

      if (this.cancelled) return;

      // Phase 9: Publish
      if (!this.isPhaseCompleted('publish')) {
        this.currentPhase = 'publish';
        const status = await publishApp(this.page, this.bus, this.state.appId);
        this.state.publishStatus = status;
        this.completePhase('publish');
      } else {
        this.bus.sendPhase('publish', 'skipped', '应用已发布');
      }

      // All done!
      this.clearState();
      this.bus.sendDone(true, '所有步骤已完成！飞书机器人已配置并连接到 OpenClaw。');

    } catch (err) {
      await this.takeScreenshot(`error-${this.currentPhase}`);
      this.bus.sendError(this.currentPhase, err.message);
      this.bus.sendDone(false, `步骤 "${this.currentPhase}" 失败: ${err.message}`);
    } finally {
      this.running = false;
      if (this._dismissInterval) {
        clearInterval(this._dismissInterval);
        this._dismissInterval = null;
      }
      if (this.browser) {
        // Keep browser open for a bit so user can see the result
        setTimeout(async () => {
          try {
            await this.browser.close();
          } catch {
            // already closed
          }
        }, 5000);
      }
    }
  }

  async retryCurrent() {
    if (!this.currentPhase) {
      throw new Error('No phase to retry');
    }
    // Remove the current phase from completed so it reruns
    this.state.completedPhases = this.state.completedPhases.filter(p => p !== this.currentPhase);
    this.saveState();
    this.bus.sendLog(`重试阶段: ${this.currentPhase}`);

    // Re-run from current phase
    if (!this.running) {
      this.run().catch(err => {
        this.bus.sendError('retry', err.message);
      });
    }
  }

  async cancel() {
    this.cancelled = true;
    this.running = false;
    if (this.browser) {
      try {
        await this.browser.close();
      } catch {
        // already closed
      }
    }
    this.bus.sendLog('自动化已取消');
  }
}

module.exports = { Runner, PHASES };
