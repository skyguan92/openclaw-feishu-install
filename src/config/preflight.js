const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  CONFIG_PATH,
  hasLegacyGatewaysKey,
  openclawExists,
  runOpenClawJson,
} = require('./openclaw-cli');

async function runPreflight() {
  const results = {
    clawInstalled: false,
    configExists: false,
    gatewayReachable: false,
    hasPendingState: false,
    pendingState: null,
    errors: [],
  };

  results.clawInstalled = openclawExists();
  if (!results.clawInstalled) {
    results.errors.push('openclaw CLI 未安装或不在 PATH 中');
  }

  results.configExists = fs.existsSync(CONFIG_PATH);

  if (results.configExists && hasLegacyGatewaysKey()) {
    results.errors.push('检测到旧版 OpenClaw 配置（根级 gateways 字段），启动安装时会自动迁移');
  }

  results.gatewayReachable = await checkGateway();

  const statePath = path.join(os.homedir(), '.openclaw', '.feishu-setup-state.json');
  if (fs.existsSync(statePath)) {
    try {
      results.hasPendingState = true;
      results.pendingState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    } catch {
      // corrupted state
    }
  }

  return results;
}

function checkGateway() {
  if (!openclawExists()) {
    return Promise.resolve(false);
  }

  try {
    const status = runOpenClawJson(['gateway', 'status'], { timeout: 15000 });
    return Promise.resolve(Boolean(status?.rpc?.ok));
  } catch {
    return Promise.resolve(false);
  }
}

module.exports = { runPreflight, checkGateway };
