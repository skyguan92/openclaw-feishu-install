const fs = require('fs');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');
const path = require('path');
const { CONFIG_PATH } = require('../utils/paths');
const {
  getOpenClawLookupHint,
  openclawExists,
  repairLegacyConfig,
  resolveOpenClawBinary,
  resolveOpenClawPackageDir,
  runOpenClaw,
  setConfigValue,
} = require('./openclaw-cli');
const stateModule = require('./state');

const FEISHU_ACCOUNT_ID = 'default';
const WINDOWS_SHELL = process.env.ComSpec || 'cmd.exe';
const WECOM_PLUGIN_ID = 'wecom-openclaw-plugin';
const WECOM_PLUGIN_PACKAGE = '@wecom/wecom-openclaw-plugin';

function loadState() {
  return stateModule.loadState();
}

function ensurePluginAllowList(bus, requiredPluginIds) {
  const normalizedRequired = Array.from(new Set(requiredPluginIds.filter(Boolean)));
  if (!normalizedRequired.length) {
    return;
  }

  let currentAllow = [];
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.plugins?.allow)) {
      currentAllow = parsed.plugins.allow.filter((value) => typeof value === 'string' && value.trim());
    }
  } catch {
    // ignore config read failures and fall back to required list only
  }

  const nextAllow = Array.from(new Set([...currentAllow, ...normalizedRequired]));
  if (!nextAllow.length) {
    return;
  }

  setConfigValue('plugins.allow', nextAllow);
  if (bus) {
    bus.sendLog(`已同步 OpenClaw plugins.allow: ${nextAllow.join(', ')}`);
  }
}

async function configureFeishuOpenClaw(bus, appId, appSecret, options = {}) {
  bus.sendLog('配置 OpenClaw 飞书连接...');
  if (!openclawExists()) {
    throw new Error(getOpenClawLookupHint());
  }

  const openclawBin = resolveOpenClawBinary();
  if (openclawBin) {
    bus.sendLog(`使用 OpenClaw CLI: ${openclawBin}`);
  }

  repairLegacyConfig(bus);

  ensureFeishuPlugin(bus);
  ensureFeishuSdk(bus);
  ensurePluginAllowList(bus, ['feishu']);

  setConfigValue('gateway.mode', 'local');
  setConfigValue('channels.feishu.enabled', true);
  setConfigValue('channels.feishu.connectionMode', 'websocket');
  setConfigValue('channels.feishu.streaming', false);
  setConfigValue('channels.feishu.defaultAccount', FEISHU_ACCOUNT_ID);
  setConfigValue(`channels.feishu.accounts.${FEISHU_ACCOUNT_ID}.appId`, appId);
  setConfigValue(`channels.feishu.accounts.${FEISHU_ACCOUNT_ID}.appSecret`, appSecret);
  if (options.botName) {
    setConfigValue(`channels.feishu.accounts.${FEISHU_ACCOUNT_ID}.botName`, options.botName);
  }
  if (options.skipPairingApproval === true) {
    setConfigValue('channels.feishu.dmPolicy', 'open');
    setConfigValue('channels.feishu.allowFrom', ['*']);
    bus.sendLog('已启用快速私聊模式：channels.feishu.dmPolicy=open，allowFrom=["*"]（仅建议个人自用）');
  } else {
    setConfigValue('channels.feishu.dmPolicy', 'pairing');
    try {
      runOpenClaw(['config', 'unset', 'channels.feishu.allowFrom'], { timeout: 60000 });
    } catch {
      // allow empty/unset configs
    }
    bus.sendLog('已启用默认私聊配对策略：首次私聊仍需 pairing approve');
  }

  runOpenClaw(['config', 'validate'], { timeout: 60000 });

  bus.sendLog('已写入 channels.feishu.* 配置，默认关闭 streaming card，并设置 gateway.mode=local');
}

async function configureWecomOpenClaw(bus, botId, botSecret, options = {}) {
  bus.sendLog('配置 OpenClaw 企业微信连接...');
  if (!openclawExists()) {
    throw new Error(getOpenClawLookupHint());
  }

  const openclawBin = resolveOpenClawBinary();
  if (openclawBin) {
    bus.sendLog(`使用 OpenClaw CLI: ${openclawBin}`);
  }

  repairLegacyConfig(bus);
  ensureWecomPlugin(bus);
  ensurePluginAllowList(bus, [WECOM_PLUGIN_ID]);

  setConfigValue('gateway.mode', 'local');
  setConfigValue('channels.wecom.enabled', true);
  setConfigValue('channels.wecom.botId', botId);
  setConfigValue('channels.wecom.secret', botSecret);
  if (options.botName) {
    setConfigValue('channels.wecom.name', options.botName);
  }
  if (options.websocketUrl) {
    setConfigValue('channels.wecom.websocketUrl', options.websocketUrl);
  }

  runOpenClaw(['config', 'validate'], { timeout: 60000 });

  bus.sendLog('已写入 channels.wecom.* 配置，使用企业微信智能机器人长连接模式');
}

function ensureFeishuPlugin(bus) {
  try {
    runOpenClaw(['plugins', 'enable', 'feishu'], { timeout: 60000 });
    bus.sendLog('飞书插件已启用');
  } catch (err) {
    bus.sendLog('内置飞书插件未启用，尝试安装 @openclaw/feishu...');
    runOpenClaw(['plugins', 'install', '@openclaw/feishu'], { timeout: 120000 });
    runOpenClaw(['plugins', 'enable', 'feishu'], { timeout: 60000 });
    bus.sendLog('飞书插件安装并启用完成');
  }
}

function ensureFeishuSdk(bus) {
  const packageDir = resolveOpenClawPackageDir();
  if (!packageDir) {
    bus.sendLog('未能定位 OpenClaw 安装目录，跳过飞书 SDK 检查');
    return;
  }

  const sdkPackageJson = getInstalledFeishuSdkPackageJson(packageDir);

  if (sdkPackageJson) {
    bus.sendLog('飞书 SDK 已安装');
    return;
  }

  const installDir = resolveFeishuSdkInstallDir(packageDir);
  bus.sendLog(`检测到飞书 SDK 缺失，准备在 ${installDir} 补装 @larksuiteoapi/node-sdk...`);

  try {
    runNpmCommand(['install', '@larksuiteoapi/node-sdk', '--no-save'], {
      cwd: installDir,
      timeout: 180000,
    });
  } catch (err) {
    const detail = getCommandErrorDetail(err);
    bus.sendLog(`直接补装飞书 SDK 失败，转为隔离安装: ${detail || err.message}`);
    installFeishuSdkViaTempDir(installDir, bus);
  }

  if (!getInstalledFeishuSdkPackageJson(packageDir)) {
    throw new Error('飞书 SDK 安装命令已执行，但仍未找到 @larksuiteoapi/node-sdk');
  }

  bus.sendLog('飞书 SDK 补装完成');
}

function getFeishuSdkPackageJsonCandidates(packageDir) {
  const candidates = [];
  const extensionDir = path.join(packageDir, 'extensions', 'feishu');

  if (fs.existsSync(path.join(extensionDir, 'package.json'))) {
    candidates.push(path.join(extensionDir, 'node_modules', '@larksuiteoapi', 'node-sdk', 'package.json'));
  }

  candidates.push(path.join(packageDir, 'node_modules', '@larksuiteoapi', 'node-sdk', 'package.json'));
  return candidates;
}

function getInstalledFeishuSdkPackageJson(packageDir) {
  return getFeishuSdkPackageJsonCandidates(packageDir).find((candidate) => fs.existsSync(candidate)) || null;
}

function resolveFeishuSdkInstallDir(packageDir) {
  const extensionDir = path.join(packageDir, 'extensions', 'feishu');
  if (fs.existsSync(path.join(extensionDir, 'package.json'))) {
    return extensionDir;
  }

  return packageDir;
}

function runNpmCommand(args, options = {}) {
  if (process.platform === 'win32') {
    const result = spawnSync(WINDOWS_SHELL, ['/d', '/s', '/c', 'npm', ...args], {
      cwd: options.cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: options.timeout || 180000,
      windowsHide: true,
    });

    if (result.error) {
      result.error.stdout = result.stdout || '';
      result.error.stderr = result.stderr || '';
      throw result.error;
    }

    if (result.status !== 0) {
      const error = new Error(getCommandErrorDetail(result) || `npm install 失败，退出码 ${result.status}`);
      error.stdout = result.stdout || '';
      error.stderr = result.stderr || '';
      throw error;
    }

    return result.stdout || '';
  }

  return execFileSync('npm', args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeout || 180000,
  });
}

function getCommandErrorDetail(err) {
  return [String(err.stderr || '').trim(), String(err.stdout || '').trim()]
    .filter(Boolean)
    .join('\n');
}

function installFeishuSdkViaTempDir(targetDir, bus) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-feishu-sdk-'));
  const tempPackageJson = path.join(tempDir, 'package.json');

  fs.writeFileSync(tempPackageJson, JSON.stringify({
    name: 'openclaw-feishu-sdk-temp',
    private: true,
  }, null, 2));

  try {
    runNpmCommand(['install', '@larksuiteoapi/node-sdk', '--no-save'], {
      cwd: tempDir,
      timeout: 180000,
    });
    const sourceNodeModules = path.join(tempDir, 'node_modules');
    const targetNodeModules = path.join(targetDir, 'node_modules');
    if (!fs.existsSync(sourceNodeModules)) {
      throw new Error('隔离安装完成，但临时目录中没有 node_modules');
    }

    fs.mkdirSync(targetNodeModules, { recursive: true });
    copyDirectoryContents(sourceNodeModules, targetNodeModules);
    bus.sendLog(`已从隔离目录复制飞书 SDK 依赖到 ${targetNodeModules}`);
  } catch (err) {
    const detail = getCommandErrorDetail(err);
    throw new Error(`飞书 SDK 隔离安装失败: ${detail || err.message}`);
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failure
    }
  }
}

function copyDirectoryContents(sourceDir, targetDir) {
  for (const entry of fs.readdirSync(sourceDir)) {
    fs.cpSync(path.join(sourceDir, entry), path.join(targetDir, entry), {
      recursive: true,
      force: true,
    });
  }
}

function ensureWecomPlugin(bus) {
  try {
    runOpenClaw(['plugins', 'enable', WECOM_PLUGIN_ID], { timeout: 60000 });
    bus.sendLog('企业微信插件已启用');
  } catch (enableErr) {
    bus.sendLog(`未检测到企业微信插件，尝试安装 ${WECOM_PLUGIN_PACKAGE}...`);
    runOpenClaw(['plugins', 'install', WECOM_PLUGIN_PACKAGE], { timeout: 180000 });
    try {
      runOpenClaw(['plugins', 'enable', WECOM_PLUGIN_ID], { timeout: 60000 });
    } catch {
      // some plugin installs are auto-enabled; continue to validation below
    }
    bus.sendLog('企业微信插件安装完成');
  }
}

module.exports = {
  configureFeishuOpenClaw,
  configureWecomOpenClaw,
  loadState,
};
