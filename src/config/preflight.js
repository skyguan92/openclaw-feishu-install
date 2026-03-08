const fs = require('fs');
const {
  CONFIG_PATH,
  getOpenClawLookupHint,
  hasLegacyGatewaysKey,
  openclawExists,
  resolveOpenClawBinary,
  runOpenClawJson,
} = require('./openclaw-cli');
const { STATE_FILE } = require('../utils/paths');

async function runPreflight() {
  const results = {
    clawInstalled: false,
    configExists: false,
    gatewayReachable: false,
    hasPendingState: false,
    pendingState: null,
    clawPath: null,
    errors: [],
  };

  results.clawInstalled = openclawExists();
  results.clawPath = resolveOpenClawBinary();
  if (!results.clawInstalled) {
    results.errors.push(getOpenClawLookupHint());
  }

  results.configExists = fs.existsSync(CONFIG_PATH);

  if (results.configExists && hasLegacyGatewaysKey()) {
    results.errors.push('检测到旧版 OpenClaw 配置（根级 gateways 字段），启动安装时会自动迁移');
  }

  results.gatewayReachable = await checkGateway();

  if (fs.existsSync(STATE_FILE)) {
    try {
      results.hasPendingState = true;
      results.pendingState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
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
