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
const { STATE_FILE } = require('../utils/paths');

const FEISHU_ACCOUNT_ID = 'default';

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    }
  } catch {
    // corrupted
  }
  return null;
}

async function configureOpenClaw(bus, appId, appSecret, options = {}) {
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

module.exports = { configureOpenClaw, loadState };
