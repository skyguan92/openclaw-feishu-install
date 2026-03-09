const fs = require('fs');
const {
  CONFIG_PATH,
  getOpenClawLookupHint,
  hasLegacyGatewaysKey,
  openclawExists,
  resolveOpenClawBinary,
  runOpenClawJson,
} = require('./openclaw-cli');
const stateModule = require('./state');

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

  const pendingState = stateModule.loadState();
  if (pendingState) {
    results.hasPendingState = true;
    results.pendingState = pendingState;
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
