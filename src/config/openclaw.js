const fs = require('fs');
const { execFileSync } = require('child_process');
const path = require('path');
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

function loadState() {
  return stateModule.loadState();
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

  const sdkPackageJson = path.join(
    packageDir,
    'node_modules',
    '@larksuiteoapi',
    'node-sdk',
    'package.json'
  );

  if (fs.existsSync(sdkPackageJson)) {
    bus.sendLog('飞书 SDK 已安装');
    return;
  }

  bus.sendLog('检测到飞书 SDK 缺失，正在补装 @larksuiteoapi/node-sdk...');

  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

  try {
    execFileSync(npmCommand, ['install', '@larksuiteoapi/node-sdk', '--no-save'], {
      cwd: packageDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 180000,
    });
  } catch (err) {
    const detail = [String(err.stderr || '').trim(), String(err.stdout || '').trim()]
      .filter(Boolean)
      .join('\n');
    throw new Error(`飞书 SDK 安装失败: ${detail || err.message}`);
  }

  if (!fs.existsSync(sdkPackageJson)) {
    throw new Error('飞书 SDK 安装命令已执行，但仍未找到 @larksuiteoapi/node-sdk');
  }

  bus.sendLog('飞书 SDK 补装完成');
}

function ensureWecomPlugin(bus) {
  try {
    runOpenClaw(['plugins', 'enable', 'wecom-openclaw-plugin'], { timeout: 60000 });
    bus.sendLog('企业微信插件已启用');
  } catch (enableErr) {
    bus.sendLog('未检测到企业微信插件，尝试安装 @wecom/wecom-openclaw-plugin...');
    runOpenClaw(['plugins', 'install', '@wecom/wecom-openclaw-plugin'], { timeout: 180000 });
    try {
      runOpenClaw(['plugins', 'enable', 'wecom-openclaw-plugin'], { timeout: 60000 });
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
