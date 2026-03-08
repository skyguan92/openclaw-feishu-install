const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OPENCLAW_BIN = 'openclaw';
const CONFIG_PATH = path.join(os.homedir(), '.openclaw', 'openclaw.json');

function openclawExists() {
  try {
    execFileSync('which', [OPENCLAW_BIN], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function runOpenClaw(args, options = {}) {
  try {
    return execFileSync(OPENCLAW_BIN, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: options.timeout || 60000,
    }).trim();
  } catch (err) {
    const stdout = (err.stdout || '').toString().trim();
    const stderr = (err.stderr || '').toString().trim();
    const detail = [stderr, stdout].filter(Boolean).join('\n');
    throw new Error(detail || err.message);
  }
}

function runOpenClawJson(args, options = {}) {
  const output = runOpenClaw([...args, '--json'], options);
  return JSON.parse(output);
}

function setConfigValue(configPath, value) {
  return runOpenClaw(
    ['config', 'set', configPath, JSON.stringify(value), '--strict-json'],
    { timeout: 60000 }
  );
}

function repairLegacyConfig(bus) {
  if (!fs.existsSync(CONFIG_PATH)) {
    return false;
  }

  const config = readConfigJson();
  if (!config) {
    return false;
  }

  if (!Object.prototype.hasOwnProperty.call(config, 'gateways')) {
    return false;
  }

  const backupPath = `${CONFIG_PATH}.legacy-${Date.now()}.bak`;
  fs.copyFileSync(CONFIG_PATH, backupPath);
  delete config.gateways;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));

  if (bus) {
    bus.sendLog(`检测到旧版 OpenClaw 配置，已备份到 ${backupPath}`);
    bus.sendLog('已移除不兼容的根级 gateways 字段');
  }

  return true;
}

function hasLegacyGatewaysKey() {
  const config = readConfigJson();
  return Boolean(config && Object.prototype.hasOwnProperty.call(config, 'gateways'));
}

function readConfigJson() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return null;
  }
}

module.exports = {
  CONFIG_PATH,
  hasLegacyGatewaysKey,
  openclawExists,
  repairLegacyConfig,
  runOpenClaw,
  runOpenClawJson,
  setConfigValue,
};
