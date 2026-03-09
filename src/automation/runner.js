const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { waitForLogin: waitForFeishuLogin } = require('./login');
const { createApp } = require('./create-app');
const { extractCredentials } = require('./credentials');
const { enableBot } = require('./bot');
const { configurePermissions } = require('./permissions');
const { configureEvents } = require('./events-subscription');
const { publishApp } = require('./publish');
const { createWecomBot, waitForWecomLogin } = require('./wecom');
const openclawConfig = require('../config/openclaw');
const gatewayConfig = require('../config/gateway');
const { dismissModals } = require('./dismiss-modals');
const { findSystemBrowserExecutable } = require('../utils/browser');
const {
  getBrowserProfileDir,
  SCREENSHOT_DIR,
} = require('../utils/paths');
const stateModule = require('../config/state');
const {
  DEFAULT_CHANNEL,
  getChannelSpec,
  normalizeChannel,
} = require('../config/channels');
const {
  getWindowsInteractiveTaskCommand,
  isLikelyWindowsSshSession,
} = require('../utils/runtime-context');

const BROWSER_PROFILE_LOCK_FILES = [
  'SingletonLock',
  'SingletonCookie',
  'SingletonSocket',
  'lockfile',
];

function createPhaseIndex(phases) {
  return Object.fromEntries(phases.map((phase, index) => [phase, index]));
}

function createInitialState(channel = DEFAULT_CHANNEL) {
  return {
    channel,
    completedPhases: [],
    currentPhase: null,
    appId: null,
    appSecret: null,
    feishuAppUrl: null,
    publishStatus: null,
    appName: '',
    botName: '',
    appDescription: '',
    skipPairingApproval: false,
    botId: '',
    botSecret: '',
    websocketUrl: '',
    wecomBotUrl: null,
    lastError: null,
    lastRun: null,
  };
}

function normalizePhase(phase, fallback, phaseIndex) {
  if (!phase) {
    return fallback;
  }

  if (!Object.prototype.hasOwnProperty.call(phaseIndex, phase)) {
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

function getFirstIncompletePhase(phases, completedPhases) {
  return phases.find((phase) => !completedPhases.includes(phase)) || phases[0];
}

function getPhaseRange(phases, phaseIndex, startPhase, endPhase) {
  const startIndex = phaseIndex[startPhase];
  const endIndex = phaseIndex[endPhase];

  if (endIndex < startIndex) {
    throw new Error(`结束阶段 ${endPhase} 不能早于开始阶段 ${startPhase}`);
  }

  return phases.slice(startIndex, endIndex + 1);
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

async function launchPersistentContext(profileDir, launchOptions, bus) {
  try {
    return await chromium.launchPersistentContext(profileDir, launchOptions);
  } catch (err) {
    if (!isProfileLockError(err)) {
      throw err;
    }

    const removedLocks = clearBrowserProfileLocks(profileDir);
    if (!removedLocks.length) {
      throw err;
    }

    bus.sendLog(`检测到浏览器 profile 锁文件，已清理后重试: ${removedLocks.join(', ')}`);
    return chromium.launchPersistentContext(profileDir, launchOptions);
  }
}

class Runner {
  constructor(bus, options = {}) {
    this.bus = bus;
    const preferredChannel = normalizeChannel(options.channel, DEFAULT_CHANNEL);
    const loadedState = this.loadState(preferredChannel);
    this.channel = normalizeChannel(options.channel || loadedState.channel, DEFAULT_CHANNEL);
    this.options = {
      channel: this.channel,
      appName: trimValue(options.appName),
      botName: trimValue(options.botName),
      appDescription: trimValue(options.appDescription),
      appId: trimValue(options.appId),
      appSecret: trimValue(options.appSecret),
      botId: trimValue(options.botId),
      botSecret: trimValue(options.botSecret),
      websocketUrl: trimValue(options.websocketUrl),
      skipPairingApproval: options.skipPairingApproval === true,
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
    this.channelSpec = getChannelSpec(this.channel);
    this.phases = this.channelSpec.phases.slice();
    this.phaseIndex = createPhaseIndex(this.phases);
    this.browserPhases = new Set(this.channelSpec.browserPhases);
    this.state = loadedState;

    if (this.options.resetState || loadedState.channel !== this.channel) {
      this.state = createInitialState(this.channel);
    }

    this.state = {
      ...createInitialState(this.channel),
      ...this.state,
      channel: this.channel,
      completedPhases: Array.isArray(this.state.completedPhases)
        ? this.state.completedPhases.filter((phase) => Object.prototype.hasOwnProperty.call(this.phaseIndex, phase))
        : [],
    };

    this.explicitStartPhase = Boolean(this.options.startPhase);
    this.explicitEndPhase = Boolean(this.options.endPhase);
    this.startPhase = normalizePhase(
      this.options.startPhase,
      getFirstIncompletePhase(this.phases, this.state.completedPhases),
      this.phaseIndex
    );
    this.endPhase = normalizePhase(
      this.options.endPhase,
      this.phases[this.phases.length - 1],
      this.phaseIndex
    );

    if (this.explicitStartPhase) {
      this.invalidateStateFromPhase(this.startPhase);
    }

    this.mergeOptionState();
    this.selectedPhases = getPhaseRange(this.phases, this.phaseIndex, this.startPhase, this.endPhase);
    this.requiresBrowser = this.selectedPhases.some((phase) => this.browserPhases.has(phase));
    this.recordRunMetadata();
    this.saveState();
  }

  loadState(channel) {
    return stateModule.loadState({ channel }) || createInitialState(channel);
  }

  saveState() {
    stateModule.saveState(this.state);
  }

  clearState() {
    stateModule.clearState();
  }

  recordRunMetadata() {
    this.state.lastRun = {
      startPhase: this.startPhase,
      endPhase: this.endPhase,
      clearLogin: this.options.clearLogin,
      skipPairingApproval: this.options.skipPairingApproval,
      updatedAt: new Date().toISOString(),
    };
    this.state.lastError = null;
  }

  mergeOptionState() {
    this.state.channel = this.channel;

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

    if (this.options.botId) {
      this.state.botId = this.options.botId;
    }

    if (this.options.botSecret) {
      this.state.botSecret = this.options.botSecret;
    }

    if (this.options.websocketUrl) {
      this.state.websocketUrl = this.options.websocketUrl;
    }

    this.state.skipPairingApproval = this.options.skipPairingApproval;
  }

  invalidateStateFromPhase(phase) {
    const phaseIndex = this.phaseIndex[phase];

    this.state.completedPhases = this.state.completedPhases.filter(
      (completedPhase) => this.phaseIndex[completedPhase] < phaseIndex
    );
    this.state.currentPhase = null;

    if (this.channel === 'wecom') {
      if (phaseIndex <= this.phaseIndex.create_bot) {
        this.state.botId = '';
        this.state.botSecret = '';
        this.state.wecomBotUrl = null;
      }
      this.state.lastError = null;
      return;
    }

    if (phaseIndex <= this.phaseIndex.create_app) {
      this.state.appId = null;
      this.state.appSecret = null;
      this.state.feishuAppUrl = null;
      this.state.publishStatus = null;
      return;
    }

    if (phaseIndex <= this.phaseIndex.credentials) {
      this.state.appSecret = null;
      this.state.publishStatus = null;
      return;
    }

    if (phaseIndex <= this.phaseIndex.publish) {
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
    if (this.channel === 'wecom') {
      const phaseErrors = [];
      const producesBotCredentials = this.phaseSelected('create_bot');

      if (this.phaseSelected('create_bot') && !this.state.botName) {
        phaseErrors.push('执行 create_bot 阶段前需要提供企业微信机器人名称 botName');
      }

      if (this.phaseSelected('configure_openclaw')) {
        if (!this.state.botId && !producesBotCredentials) {
          phaseErrors.push('执行 configure_openclaw 阶段前需要提供企业微信 botId');
        }
        if (!this.state.botSecret && !producesBotCredentials) {
          phaseErrors.push('执行 configure_openclaw 阶段前需要提供企业微信 botSecret');
        }
      }

      if (
        this.phaseSelected('restart_gateway')
        && !this.phaseSelected('configure_openclaw')
        && (!this.state.botId || !this.state.botSecret)
      ) {
        phaseErrors.push('仅执行 restart_gateway 时，需要先完成企业微信配置，或从 configure_openclaw 阶段开始');
      }

      if (phaseErrors.length) {
        throw new Error(phaseErrors.join('；'));
      }

      return;
    }

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

    for (const phase of this.phases) {
      if (this.phaseSelected(phase)) {
        continue;
      }

      if (this.phaseIndex[phase] < this.phaseIndex[this.startPhase]) {
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
    const profileDir = getBrowserProfileDir(this.channel);

    try {
      this.browser = await launchPersistentContext(profileDir, launchOptions, this.bus);
    } catch {
      this.bus.sendLog('Playwright 自带浏览器未安装，尝试使用系统 Chrome / Edge...');
      const systemBrowserPath = findSystemBrowserExecutable();
      if (!systemBrowserPath) {
        throw new Error(
          '未找到可用浏览器。请运行 npx playwright install chromium，或安装 Google Chrome / Microsoft Edge'
        );
      }

      launchOptions.executablePath = systemBrowserPath;
      this.browser = await launchPersistentContext(profileDir, launchOptions, this.bus);
      this.bus.sendLog(`使用系统浏览器: ${systemBrowserPath}`);
    }

    this.bus.sendLog(`使用持久化浏览器目录: ${profileDir}`);

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
    if (this.channel === 'wecom') {
      await waitForWecomLogin(this.page, this.bus, { reportPhase });
    } else {
      await waitForFeishuLogin(this.page, this.bus, { reportPhase });
    }

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

    if (phase !== 'login' && this.browserPhases.has(phase)) {
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

      if (this.channel === 'feishu') {
        await this.runFeishuPhases();
      } else if (this.channel === 'wecom') {
        await this.runWecomPhases();
      } else {
        throw new Error(`不支持的渠道: ${this.channel}`);
      }

      const finishedAllPhases = this.phases.every((phase) => this.state.completedPhases.includes(phase));
      if (finishedAllPhases && this.endPhase === this.phases[this.phases.length - 1]) {
        this.clearState();
        this.bus.sendDone(true, this.channelSpec.completionMessage);
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

    this.state = this.loadState(this.channel);
    this.options.startPhase = targetPhase;
    this.explicitStartPhase = true;
    this.startPhase = normalizePhase(targetPhase, targetPhase, this.phaseIndex);
    this.invalidateStateFromPhase(this.startPhase);
    this.mergeOptionState();
    this.selectedPhases = getPhaseRange(this.phases, this.phaseIndex, this.startPhase, this.endPhase);
    this.requiresBrowser = this.selectedPhases.some((phase) => this.browserPhases.has(phase));
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

  async runFeishuPhases() {
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
      await openclawConfig.configureFeishuOpenClaw(
        this.bus,
        this.state.appId,
        this.state.appSecret,
        {
          botName: this.state.botName,
          skipPairingApproval: this.state.skipPairingApproval,
        }
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
  }

  async runWecomPhases() {
    if (this.phaseSelected('login')) {
      await this.runSelectedPhase('login', async () => {
        await this.ensureLoggedIn(true);
      }, '企业微信登录已完成');
    }

    await this.runSelectedPhase('create_bot', async () => {
      await this.ensureBrowser();
      await this.ensureLoggedIn(false);
      this.bus.sendPhase('create_bot', 'running', '正在创建企业微信机器人...');
      const result = await createWecomBot(this.page, this.bus, {
        botName: this.state.botName,
        description: this.state.appDescription,
      });
      this.state.botId = result.botId;
      this.state.botSecret = result.botSecret;
      this.state.wecomBotUrl = result.detailUrl;
      this.bus.sendPhase('create_bot', 'done', '企业微信机器人创建完成');
    }, this.state.botId ? `企业微信机器人已创建: ${this.state.botId}` : '企业微信机器人已创建');

    await this.runSelectedPhase('configure_openclaw', async () => {
      this.bus.sendPhase('configure_openclaw', 'running', '正在配置企业微信到 OpenClaw...');
      await openclawConfig.configureWecomOpenClaw(
        this.bus,
        this.state.botId,
        this.state.botSecret,
        {
          botName: this.state.botName,
          websocketUrl: this.state.websocketUrl,
        }
      );
      this.bus.sendPhase('configure_openclaw', 'done', '企业微信配置完成');
    }, '企业微信已配置');

    await this.runSelectedPhase('restart_gateway', async () => {
      this.bus.sendPhase('restart_gateway', 'running', '正在重启 Gateway...');
      const verifyStartedAt = Date.now();
      await gatewayConfig.restartGateway(this.bus);
      await gatewayConfig.waitForWecomChannelConnected(this.bus, {
        since: verifyStartedAt,
      });
      this.bus.sendPhase('restart_gateway', 'done', 'Gateway 重启成功');
    }, 'Gateway 已就绪');
  }
}

module.exports = { Runner };
