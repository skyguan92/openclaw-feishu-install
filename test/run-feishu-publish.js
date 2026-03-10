const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { waitForLogin } = require('../src/automation/login');
const { publishApp } = require('../src/automation/publish');
const { findSystemBrowserExecutable } = require('../src/utils/browser');
const { CONFIG_PATH, getBrowserProfileDir } = require('../src/utils/paths');

const BROWSER_PROFILE_LOCK_FILES = [
  'SingletonLock',
  'SingletonCookie',
  'SingletonSocket',
  'lockfile',
];

class ConsoleBus {
  sendPhase(phase, status, message) {
    console.log(`[phase] ${phase} ${status} ${message}`);
  }

  sendLog(message) {
    console.log(`[log] ${message}`);
  }

  sendError(phase, message) {
    console.error(`[error] ${phase} ${message}`);
  }

  sendDone(success, message) {
    console.log(`[done] ${success ? 'success' : 'failed'} ${message}`);
  }
}

function resolveAppId() {
  const argAppId = (process.argv.slice(2).find((arg) => !arg.startsWith('--')) || '').trim();
  if (argAppId) {
    return argAppId;
  }

  const envAppId = (process.env.FEISHU_APP_ID || '').trim();
  if (envAppId) {
    return envAppId;
  }

  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    return config?.channels?.feishu?.accounts?.default?.appId || '';
  } catch {
    return '';
  }
}

function shouldForceNewVersion() {
  return process.argv.includes('--force') || process.env.FORCE_NEW_VERSION === '1';
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
      // ignore cleanup failure
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

async function main() {
  const appId = resolveAppId();
  if (!appId) {
    throw new Error('未找到可用的飞书 appId。可通过命令参数或 FEISHU_APP_ID 传入。');
  }

  const bus = new ConsoleBus();
  const forceNewVersion = shouldForceNewVersion();
  const launchOptions = {
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
    viewport: { width: 1280, height: 900 },
    locale: 'zh-CN',
  };

  const systemBrowserPath = findSystemBrowserExecutable();
  if (systemBrowserPath) {
    launchOptions.executablePath = systemBrowserPath;
  }

  const profileDir = getBrowserProfileDir('feishu');
  bus.sendLog(`使用 appId=${appId}`);
  bus.sendLog(`使用浏览器目录: ${profileDir}`);
  bus.sendLog(`强制新建版本测试: ${forceNewVersion ? '开启' : '关闭'}`);

  const browser = await launchPersistentContext(profileDir, launchOptions, bus);
  const page = browser.pages()[0] || await browser.newPage();

  try {
    await waitForLogin(page, bus, { reportPhase: true });
    const publishStatus = await publishApp(page, bus, appId, { forceNewVersion });
    bus.sendDone(true, `发布阶段完成: ${publishStatus}`);
  } finally {
    setTimeout(async () => {
      try {
        await browser.close();
      } catch {
        // ignore
      }
    }, 5000);
  }
}

main().catch((err) => {
  console.error(`[fatal] ${err.message}`);
  process.exitCode = 1;
});
