/**
 * Feishu automation integration test.
 *
 * - Mocks OpenClaw CLI interactions (preflight, config write)
 * - Runs REAL Playwright automation against Feishu developer console
 * - Starts a REAL mock gateway that connects to Feishu via WebSocket
 *   (needed because event subscription config requires a live long connection)
 *
 * Usage: node test/run-feishu-test.js
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

// ── Mock setup ──────────────────────────────────────────────────────────
const MOCK_OPENCLAW_DIR = path.join(os.tmpdir(), 'openclaw-test-' + Date.now());
fs.mkdirSync(MOCK_OPENCLAW_DIR, { recursive: true });

const fakeConfig = { gateways: [] };
fs.writeFileSync(
  path.join(MOCK_OPENCLAW_DIR, 'openclaw.json'),
  JSON.stringify(fakeConfig, null, 2)
);

// Load modules to mock
const openclawConfig = require('../src/config/openclaw');
const gateway = require('../src/config/gateway');
const preflight = require('../src/config/preflight');
const { MockGateway } = require('../src/config/mock-gateway');

// Track the mock gateway instance so we can start it after credentials are obtained
let mockGw = null;

// ── Mock: configureOpenClaw ─────────────────────────────────────────────
openclawConfig.configureOpenClaw = async function mockConfigureOpenClaw(bus, appId, appSecret) {
  bus.sendLog('[MOCK] configureOpenClaw called');
  bus.sendLog(`[MOCK] appId=${appId}, appSecret=${appSecret ? appSecret.substring(0, 6) + '...' : 'null'}`);

  const mockConfigPath = path.join(MOCK_OPENCLAW_DIR, 'openclaw.json');
  const config = JSON.parse(fs.readFileSync(mockConfigPath, 'utf-8'));
  config.gateways.push({
    type: 'feishu',
    platform: 'feishu',
    appId,
    appSecret,
    enabled: true,
  });
  fs.writeFileSync(mockConfigPath, JSON.stringify(config, null, 2));
  bus.sendLog('[MOCK] Config written to ' + mockConfigPath);
};

// ── Mock: restartGateway → start real Feishu WebSocket connection ──────
gateway.restartGateway = async function mockRestartGateway(bus) {
  bus.sendLog('[MockGateway] Gateway already running with Feishu WebSocket connection');
  // If mock gateway is connected, health check passes
  if (mockGw && mockGw.connected) {
    bus.sendLog('[MockGateway] WebSocket connection confirmed active');
  } else {
    bus.sendLog('[MockGateway] Warning: WebSocket not connected (may be OK for testing)');
  }
};

// ── Mock: preflight ─────────────────────────────────────────────────────
preflight.runPreflight = async function mockRunPreflight() {
  return {
    clawInstalled: true,
    configExists: true,
    gatewayReachable: true,
    hasPendingState: false,
    pendingState: null,
    errors: [],
  };
};

// ── Mock: loadState ─────────────────────────────────────────────────────
openclawConfig.loadState = function mockLoadState() {
  const statePath = path.join(MOCK_OPENCLAW_DIR, '.feishu-setup-state.json');
  try {
    if (fs.existsSync(statePath)) {
      return JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    }
  } catch {}
  return null;
};

// ── Patch Runner ────────────────────────────────────────────────────────
const runnerModule = require('../src/automation/runner');
const OriginalRunner = runnerModule.Runner;

class MockRunner extends OriginalRunner {
  constructor(bus, options) {
    super(bus, options);
    this._stateFile = path.join(MOCK_OPENCLAW_DIR, '.feishu-setup-state.json');
    this._screenshotDir = path.join(MOCK_OPENCLAW_DIR, 'screenshots');
  }

  loadState() {
    const stateFile = this._stateFile || path.join(MOCK_OPENCLAW_DIR, '.feishu-setup-state.json');
    try {
      if (fs.existsSync(stateFile)) {
        return JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
      }
    } catch {}
    return { completedPhases: [], appId: null, appSecret: null };
  }

  saveState() {
    fs.mkdirSync(path.dirname(this._stateFile), { recursive: true });
    fs.writeFileSync(this._stateFile, JSON.stringify(this.state, null, 2));
  }

  clearState() {
    try { fs.unlinkSync(this._stateFile); } catch {}
  }

  async takeScreenshot(name) {
    if (!this.page) return;
    try {
      fs.mkdirSync(this._screenshotDir, { recursive: true });
      const filePath = path.join(this._screenshotDir, `${name}-${Date.now()}.png`);
      await this.page.screenshot({ path: filePath, fullPage: true });
      this.bus.sendLog(`Screenshot saved: ${filePath}`);
    } catch {}
  }

  // Override run() to inject mock gateway startup after credentials phase
  async run() {
    this.running = true;
    this.cancelled = false;

    const { chromium } = require('playwright');
    const { waitForLogin } = require('../src/automation/login');
    const { createApp } = require('../src/automation/create-app');
    const { extractCredentials } = require('../src/automation/credentials');
    const { enableBot } = require('../src/automation/bot');
    const { configurePermissions } = require('../src/automation/permissions');
    const { configureEvents } = require('../src/automation/events-subscription');
    const { publishApp } = require('../src/automation/publish');

    try {
      this.bus.sendLog('Starting Playwright browser...');

      const launchOptions = {
        headless: false,
        args: ['--disable-blink-features=AutomationControlled'],
      };

      // Use system Chrome
      const chromePaths = [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium-browser',
      ];
      for (const p of chromePaths) {
        if (fs.existsSync(p)) {
          launchOptions.executablePath = p;
          break;
        }
      }

      this.browser = await chromium.launch(launchOptions);
      const context = await this.browser.newContext({
        viewport: { width: 1280, height: 900 },
        locale: 'zh-CN',
      });
      this.page = await context.newPage();

      // Phase 1: Login
      if (!this.isPhaseCompleted('login')) {
        this.currentPhase = 'login';
        await waitForLogin(this.page, this.bus);
        this.completePhase('login');
      } else {
        this.bus.sendPhase('login', 'skipped', 'Login already completed');
        await this.page.goto('https://open.feishu.cn/app', { waitUntil: 'domcontentloaded' });
        await this.page.waitForTimeout(2000);
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
        this.bus.sendPhase('create_app', 'skipped', `App exists: ${this.state.appId}`);
      }
      if (this.cancelled) return;

      // Phase 3: Get Credentials
      if (!this.isPhaseCompleted('credentials')) {
        this.currentPhase = 'credentials';
        const creds = await extractCredentials(this.page, this.bus, this.state.appId);
        this.state.appSecret = creds.appSecret;
        this.completePhase('credentials');
      } else {
        this.bus.sendPhase('credentials', 'skipped', 'Credentials already obtained');
      }
      if (this.cancelled) return;

      // ★ START MOCK GATEWAY with real Feishu WebSocket connection
      // Must happen BEFORE event subscription so Feishu can verify the connection
      if (this.state.appId && this.state.appSecret) {
        this.bus.sendLog('[MockGateway] Starting mock gateway with Feishu WebSocket...');
        mockGw = new MockGateway(this.bus);
        try {
          await mockGw.start(this.state.appId, this.state.appSecret);
          this.bus.sendLog('[MockGateway] Connected to Feishu WebSocket successfully!');
        } catch (err) {
          this.bus.sendLog(`[MockGateway] Warning: Failed to connect - ${err.message}`);
          this.bus.sendLog('[MockGateway] Continuing anyway, event subscription may not verify connection');
        }
      }

      // Phase 4: Enable Bot
      if (!this.isPhaseCompleted('bot')) {
        this.currentPhase = 'bot';
        await enableBot(this.page, this.bus, this.state.appId, this.options.botName);
        this.completePhase('bot');
      } else {
        this.bus.sendPhase('bot', 'skipped', 'Bot already enabled');
      }
      if (this.cancelled) return;

      // Phase 5: Configure Permissions
      if (!this.isPhaseCompleted('permissions')) {
        this.currentPhase = 'permissions';
        await configurePermissions(this.page, this.bus, this.state.appId);
        this.completePhase('permissions');
      } else {
        this.bus.sendPhase('permissions', 'skipped', 'Permissions already configured');
      }
      if (this.cancelled) return;

      // Phase 6: Configure Events
      if (!this.isPhaseCompleted('events')) {
        this.currentPhase = 'events';
        await configureEvents(this.page, this.bus, this.state.appId);
        this.completePhase('events');
      } else {
        this.bus.sendPhase('events', 'skipped', 'Events already configured');
      }
      if (this.cancelled) return;

      // Phase 7: Publish
      if (!this.isPhaseCompleted('publish')) {
        this.currentPhase = 'publish';
        const status = await publishApp(this.page, this.bus, this.state.appId);
        this.state.publishStatus = status;
        this.completePhase('publish');
      } else {
        this.bus.sendPhase('publish', 'skipped', 'App already published');
      }
      if (this.cancelled) return;

      // Phase 8: Configure OpenClaw (mocked)
      if (!this.isPhaseCompleted('configure_openclaw')) {
        this.currentPhase = 'configure_openclaw';
        this.bus.sendPhase('configure_openclaw', 'running', 'Configuring OpenClaw...');
        await openclawConfig.configureOpenClaw(this.bus, this.state.appId, this.state.appSecret);
        this.completePhase('configure_openclaw');
        this.bus.sendPhase('configure_openclaw', 'done', 'OpenClaw configured (mock)');
      } else {
        this.bus.sendPhase('configure_openclaw', 'skipped', 'OpenClaw already configured');
      }
      if (this.cancelled) return;

      // Phase 9: Restart Gateway (mocked - already running via MockGateway)
      if (!this.isPhaseCompleted('restart_gateway')) {
        this.currentPhase = 'restart_gateway';
        this.bus.sendPhase('restart_gateway', 'running', 'Checking Gateway...');
        await gateway.restartGateway(this.bus);
        this.completePhase('restart_gateway');
        this.bus.sendPhase('restart_gateway', 'done', 'Gateway running (mock)');
      } else {
        this.bus.sendPhase('restart_gateway', 'skipped', 'Gateway already running');
      }

      // All done!
      this.clearState();
      this.bus.sendDone(true, 'All steps completed! Mock gateway connected to Feishu.');

    } catch (err) {
      await this.takeScreenshot(`error-${this.currentPhase}`);
      this.bus.sendError(this.currentPhase, err.message);
      this.bus.sendDone(false, `Phase "${this.currentPhase}" failed: ${err.message}`);
    } finally {
      this.running = false;
      if (this.browser) {
        setTimeout(async () => {
          try { await this.browser.close(); } catch {}
        }, 5000);
      }
    }
  }
}

// Replace Runner
runnerModule.Runner = MockRunner;

// ── Start server ────────────────────────────────────────────────────────
const { createApp: createExpressApp } = require('../src/server/app');

const PORT = 19090;
const app = createExpressApp();

const server = app.listen(PORT, async () => {
  const url = `http://localhost:${PORT}`;
  console.log('');
  console.log('='.repeat(60));
  console.log('  OpenClaw Feishu Installer - TEST MODE');
  console.log('='.repeat(60));
  console.log(`  Web UI:       ${url}`);
  console.log(`  Mock dir:     ${MOCK_OPENCLAW_DIR}`);
  console.log(`  OpenClaw CLI: MOCKED`);
  console.log(`  Gateway:      REAL Feishu WebSocket (via MockGateway)`);
  console.log(`  Feishu RPA:   REAL (Playwright + system Chrome)`);
  console.log('='.repeat(60));
  console.log('');

  try {
    const open = (await import('open')).default;
    await open(url);
  } catch {
    console.log(`Open ${url} in your browser.`);
  }
});

// Cleanup on exit
process.on('SIGINT', async () => {
  console.log('\nCleaning up...');

  if (mockGw) {
    console.log('Stopping mock gateway...');
    await mockGw.stop();
  }

  try {
    const finalConfig = fs.readFileSync(path.join(MOCK_OPENCLAW_DIR, 'openclaw.json'), 'utf-8');
    console.log('Final mock config:', finalConfig);
  } catch {}

  console.log(`Mock dir: ${MOCK_OPENCLAW_DIR}`);
  server.close();
  process.exit(0);
});
