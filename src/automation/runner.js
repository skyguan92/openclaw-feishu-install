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

const PHASE_INDEX = Object.fromEntries(PHASES.map((phase, index) => [phase, index]));
const BROWSER_PHASES = new Set([
  'login',
  'create_app',
  'credentials',
  'bot',
  'permissions',
  'events',
  'publish',
]);

const BROWSER_PROFILE_LOCK_FILES = [
  'SingletonLock',
  'SingletonCookie',
  'SingletonSocket',
  'lockfile',
];

function createInitialState() {
  return {
    completedPhases: [],
    currentPhase: null,
    appId: null,
    appSecret: null,
    feishuAppUrl: null,
    publishStatus: null,
    appName: '',
    botName: '',
    appDescription: '',
    lastError: null,
    lastRun: null,
  };
}

function normalizePhase(phase, fallback) {
  if (!phase) {
    return fallback;
  }

  if (!Object.prototype.hasOwnProperty.call(PHASE_INDEX, phase)) {
    throw new Error(`未知阶段: ${phase}`);
  }

  return phase;
}

function trimValue(value) {
  if (value == null) {
    return '';
  }

  return String(value).trim();
}

function getFirstIncompletePhase(completedPhases) {
  return PHASES.find((phase) => !completedPhases.includes(phase)) || PHASES[0];
}

function getPhaseRange(startPhase, endPhase) {
  const startIndex = PHASE_INDEX[startPhase];
  const endIndex = PHASE_INDEX[endPhase];

  if (endIndex < startIndex) {
    throw new Error(`结束阶段 ${endPhase} 不能早于开始阶段 ${startPhase}`);
  }

  return PHASES.slice(startIndex, endIndex + 1);
}

function defaultAppDescription(appName) {
  return appName ? `${appName} - powered by OpenClaw` : '';
}

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
  constructor(bus, options = {}) {
    this.bus = bus;
    this.options = {
      appName: trimValue(options.appName),
      botName: trimValue(options.botName),
      appDescription: trimValue(options.appDescription),
      appId: trimValue(options.appId),
      appSecret: trimValue(options.appSecret),
      startPhase: trimValue(options.startPhase),
      endPhase: trimValue(options.endPhase),
      clearLogin: Boolean(options.clearLogin),
      resetState: Boolean(options.resetState),
    };
    this.running = false;
    this.cancelled = false;
    this.browser = null;
    this.page = null;
    this.currentPhase = null;
    this.requiresBrowser = false;
    this._dismissInterval = null;
    this._loginValidated = false;
    this.state = this.loadState();

    if (this.options.resetState) {
      this.state = createInitialState();
    }

    this.explicitStartPhase = Boolean(this.options.startPhase);
    this.explicitEndPhase = Boolean(this.options.endPhase);
    this.startPhase = normalizePhase(
      this.options.startPhase,
      getFirstIncompletePhase(this.state.completedPhases)
    );
    this.endPhase = normalizePhase(
      this.options.endPhase,
      PHASES[PHASES.length - 1]
    );

    if (this.explicitStartPhase) {
      this.invalidateStateFromPhase(this.startPhase);
    }

    this.mergeOptionState();
    this.selectedPhases = getPhaseRange(this.startPhase, this.endPhase);
    this.requiresBrowser = this.selectedPhases.some((phase) => BROWSER_PHASES.has(phase));
    this.recordRunMetadata();
    this.saveState();
  }

  loadState() {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
        return {
          ...createInitialState(),
          ...(raw && typeof raw === 'object' ? raw : {}),
          completedPhases: Array.isArray(raw?.completedPhases)
            ? raw.completedPhases.filter((phase) => Object.prototype.hasOwnProperty.call(PHASE_INDEX, phase))
            : [],
        };
      }
    } catch {
      // corrupted state
    }
    return createInitialState();
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

  recordRunMetadata() {
    this.state.lastRun = {
      startPhase: this.startPhase,
      endPhase: this.endPhase,
      clearLogin: this.options.clearLogin,
      updatedAt: new Date().toISOString(),
    };
    this.state.lastError = null;
  }

  mergeOptionState() {
    if (this.options.appName) {
      this.state.appName = this.options.appName;
    }

    if (this.options.botName) {
      this.state.botName = this.options.botName;
    }

    if (this.options.appDescription) {
      this.state.appDescription = this.options.appDescription;
    } else if (!this.state.appDescription && this.state.appName) {
      this.state.appDescription = defaultAppDescription(this.state.appName);
    }

    if (this.options.appId) {
      this.state.appId = this.options.appId;
      this.state.feishuAppUrl = `https://open.feishu.cn/app/${this.options.appId}`;
    }

    if (this.options.appSecret) {
      this.state.appSecret = this.options.appSecret;
    }
  }

  invalidateStateFromPhase(phase) {
    const phaseIndex = PHASE_INDEX[phase];

    this.state.completedPhases = this.state.completedPhases.filter(
      (completedPhase) => PHASE_INDEX[completedPhase] < phaseIndex
    );
    this.state.currentPhase = null;

    if (phaseIndex <= PHASE_INDEX.create_app) {
      this.state.appId = null;
      this.state.appSecret = null;
      this.state.feishuAppUrl = null;
      this.state.publishStatus = null;
      return;
    }

    if (phaseIndex <= PHASE_INDEX.credentials) {
      this.state.appSecret = null;
      this.state.publishStatus = null;
      return;
    }

    if (phaseIndex <= PHASE_INDEX.publish) {
      this.state.publishStatus = null;
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
    this.state.lastError = null;
    this.saveState();
  }

  phaseSelected(phase) {
    return this.selectedPhases.includes(phase);
  }

  validateSelectedPhaseInputs() {
    const phaseErrors = [];
    const producesAppId = this.phaseSelected('create_app');
    const producesAppSecret = this.phaseSelected('credentials');

    if (this.phaseSelected('create_app') && !this.state.appName) {
      phaseErrors.push('执行 create_app 阶段前需要提供应用名称 appName');
    }

    if (this.phaseSelected('credentials') && !this.state.appId && !producesAppId) {
      phaseErrors.push('执行 credentials 阶段前需要已有 appId，或从 create_app 阶段开始');
    }

    if (this.phaseSelected('bot')) {
      if (!this.state.appId && !producesAppId) {
        phaseErrors.push('执行 bot 阶段前需要已有 appId，或从 create_app 阶段开始');
      }
      if (!this.state.botName) {
        phaseErrors.push('执行 bot 阶段前需要提供机器人名称 botName');
      }
    }

    for (const phase of ['permissions', 'events', 'publish']) {
      if (this.phaseSelected(phase) && !this.state.appId && !producesAppId) {
        phaseErrors.push(`执行 ${phase} 阶段前需要已有 appId，或从 create_app 阶段开始`);
      }
    }

    if (this.phaseSelected('configure_openclaw')) {
      if (!this.state.appId && !producesAppId) {
        phaseErrors.push('执行 configure_openclaw 阶段前需要已有 appId');
      }
      if (!this.state.appSecret && !producesAppSecret) {
        phaseErrors.push('执行 configure_openclaw 阶段前需要已有 appSecret，或从 credentials 阶段开始');
      }
    }

    if (phaseErrors.length) {
      throw new Error(phaseErrors.join('；'));
    }
  }

  announcePlan() {
    this.bus.sendLog(`本次执行范围: ${this.startPhase} -> ${this.endPhase}`);

    if (this.explicitStartPhase) {
      this.bus.sendLog(`已重置 ${this.startPhase} 及后续阶段状态，将从该阶段重新执行`);
    }

    for (const phase of PHASES) {
      if (this.phaseSelected(phase)) {
        continue;
      }

      if (PHASE_INDEX[phase] < PHASE_INDEX[this.startPhase]) {
        const message = this.isPhaseCompleted(phase) ? '沿用已有结果' : '不在本次执行范围';
        this.bus.sendPhase(phase, 'skipped', message);
        continue;
      }

      this.bus.sendPhase(phase, 'skipped', '本次执行到此为止');
    }
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

  async ensureBrowser() {
    if (!this.requiresBrowser || this.browser) {
      return;
    }

    this.bus.sendLog('启动 Playwright 浏览器...');

    if (isLikelyWindowsSshSession()) {
      this.bus.sendLog('检测到 Windows SSH 会话，浏览器窗口可能不会显示在用户桌面上。');
      this.bus.sendLog(`如果用户看不到浏览器，请在桌面会话运行，或执行: ${getWindowsInteractiveTaskCommand()}`);
    }

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

    if (this.options.clearLogin) {
      await this.browser.clearCookies();
      await this.browser.clearPermissions().catch(() => {});
      this.bus.sendLog('已清除所有浏览器 cookies（强制重新登录）');
    }

    this.page = this.browser.pages()[0] || await this.browser.newPage();

    this._dismissInterval = setInterval(async () => {
      try {
        if (!this.page || this.page.isClosed()) return;
        await dismissModals(this.page, this.bus);
      } catch {
        // ignore
      }
    }, 2000);
  }

  async ensureLoggedIn(reportPhase) {
    if (!this.requiresBrowser || this._loginValidated) {
      return;
    }

    await this.ensureBrowser();
    this.currentPhase = reportPhase ? 'login' : this.currentPhase;
    await waitForLogin(this.page, this.bus, { reportPhase });

    if (reportPhase && !this.isPhaseCompleted('login')) {
      this.completePhase('login');
    }

    this._loginValidated = true;
  }

  async runSelectedPhase(phase, handler, skipMessage) {
    if (!this.phaseSelected(phase)) {
      return;
    }

    if (this.cancelled) {
      return;
    }

    if (phase !== 'login' && BROWSER_PHASES.has(phase)) {
      await this.ensureLoggedIn(false);
    }

    if (this.isPhaseCompleted(phase)) {
      this.bus.sendPhase(phase, 'skipped', skipMessage);
      return;
    }

    this.currentPhase = phase;
    this.state.currentPhase = phase;
    this.saveState();

    await handler();

    if (!this.isPhaseCompleted(phase)) {
      this.completePhase(phase);
    }
  }

  async run() {
    this.running = true;
    this.cancelled = false;
    this._loginValidated = false;

    try {
      this.validateSelectedPhaseInputs();
      this.announcePlan();

      if (this.phaseSelected('login')) {
        await this.runSelectedPhase('login', async () => {
          await this.ensureLoggedIn(true);
        }, '登录已完成');
      }

      await this.runSelectedPhase('create_app', async () => {
        await this.ensureBrowser();
        const appId = await createApp(this.page, this.bus, {
          appName: this.state.appName,
          appDescription: this.state.appDescription,
        });
        this.state.appId = appId;
        this.state.feishuAppUrl = `https://open.feishu.cn/app/${appId}`;
      }, this.state.appId ? `应用已创建: ${this.state.appId}` : '应用已创建');

      await this.runSelectedPhase('credentials', async () => {
        const creds = await extractCredentials(this.page, this.bus, this.state.appId);
        this.state.appSecret = creds.appSecret;
      }, '凭证已获取');

      await this.runSelectedPhase('bot', async () => {
        await enableBot(this.page, this.bus, this.state.appId, this.state.botName);
      }, '机器人已启用');

      await this.runSelectedPhase('permissions', async () => {
        await configurePermissions(this.page, this.bus, this.state.appId);
      }, '权限已配置');

      await this.runSelectedPhase('configure_openclaw', async () => {
        this.bus.sendPhase('configure_openclaw', 'running', '正在配置 OpenClaw...');
        await openclawConfig.configureOpenClaw(
          this.bus,
          this.state.appId,
          this.state.appSecret,
          { botName: this.state.botName }
        );
        this.bus.sendPhase('configure_openclaw', 'done', 'OpenClaw 配置完成');
      }, 'OpenClaw 已配置');

      await this.runSelectedPhase('restart_gateway', async () => {
        this.bus.sendPhase('restart_gateway', 'running', '正在重启 Gateway...');
        await gatewayConfig.restartGateway(this.bus);
        this.bus.sendPhase('restart_gateway', 'done', 'Gateway 重启成功');
      }, 'Gateway 已就绪');

      await this.runSelectedPhase('events', async () => {
        await configureEvents(this.page, this.bus, this.state.appId);
      }, '事件订阅已配置');

      await this.runSelectedPhase('publish', async () => {
        const status = await publishApp(this.page, this.bus, this.state.appId);
        this.state.publishStatus = status;
      }, '应用已发布');

      const finishedAllPhases = PHASES.every((phase) => this.state.completedPhases.includes(phase));
      if (finishedAllPhases && this.endPhase === PHASES[PHASES.length - 1]) {
        this.clearState();
        this.bus.sendDone(true, '所有步骤已完成！飞书机器人已配置并连接到 OpenClaw。');
      } else {
        this.saveState();
        this.bus.sendDone(true, `已完成到步骤 "${this.endPhase}"，可按需继续执行后续阶段。`);
      }
    } catch (err) {
      this.state.lastError = {
        phase: this.currentPhase,
        message: err.message,
        at: new Date().toISOString(),
      };
      this.state.currentPhase = this.currentPhase;
      this.saveState();
      await this.takeScreenshot(`error-${this.currentPhase || 'unknown'}`);
      this.bus.sendError(this.currentPhase || 'unknown', err.message);
      this.bus.sendDone(false, `步骤 "${this.currentPhase || 'unknown'}" 失败: ${err.message}`);
    } finally {
      this.running = false;
      if (this._dismissInterval) {
        clearInterval(this._dismissInterval);
        this._dismissInterval = null;
      }
      if (this.browser) {
        const browser = this.browser;
        this.browser = null;
        setTimeout(async () => {
          try {
            await browser.close();
          } catch {
            // already closed
          }
        }, 5000);
      }
    }
  }

  async retryCurrent(targetPhase = this.currentPhase) {
    if (!targetPhase) {
      throw new Error('No phase to retry');
    }

    this.state = this.loadState();
    this.options.startPhase = targetPhase;
    this.explicitStartPhase = true;
    this.startPhase = normalizePhase(targetPhase, targetPhase);
    this.invalidateStateFromPhase(this.startPhase);
    this.mergeOptionState();
    this.selectedPhases = getPhaseRange(this.startPhase, this.endPhase);
    this.requiresBrowser = this.selectedPhases.some((phase) => BROWSER_PHASES.has(phase));
    this.recordRunMetadata();
    this.saveState();

    this.bus.sendLog(`重试阶段: ${targetPhase}`);

    if (!this.running) {
      this.run().catch((err) => {
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
      this.browser = null;
    }
    this.bus.sendLog('自动化已取消');
  }
}

module.exports = { Runner, PHASES };
