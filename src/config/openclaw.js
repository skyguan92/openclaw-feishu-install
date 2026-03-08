const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  openclawExists,
  repairLegacyConfig,
  runOpenClaw,
  setConfigValue,
} = require('./openclaw-cli');

const FEISHU_ACCOUNT_ID = 'default';
const STATE_PATH = path.join(os.homedir(), '.openclaw', '.feishu-setup-state.json');

function loadState() {
  try {
    if (fs.existsSync(STATE_PATH)) {
      return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
    }
  } catch {
    // corrupted
  }
  return null;
}

async function configureOpenClaw(bus, appId, appSecret, options = {}) {
  bus.sendLog('配置 OpenClaw 飞书连接...');
  if (!openclawExists()) {
    throw new Error('openclaw CLI 未安装或不在 PATH 中');
  }

  repairLegacyConfig(bus);

  ensureFeishuPlugin(bus);

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

module.exports = { configureOpenClaw, loadState };
