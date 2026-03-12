const fs = require('fs');
const { MAIN_AGENT_AUTH_PROFILES_PATH } = require('../utils/paths');
const {
  CONFIG_PATH,
  getOpenClawLookupHint,
  hasLegacyGatewaysKey,
  openclawExists,
  resolveOpenClawBinary,
  resolveOpenClawPackageDir,
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
    openclawPackageDir: null,
    nodeVersion: process.versions.node,
    nodeVersionSatisfied: false,
    pluginPackages: {
      feishu: { detected: false, packagePath: null },
      wecom: { detected: false, packagePath: null },
    },
    errors: [],
    warnings: [],
  };

  results.nodeVersionSatisfied = getNodeMajorVersion(results.nodeVersion) >= 22;
  if (!results.nodeVersionSatisfied) {
    results.errors.push(`当前 Node.js 版本是 ${results.nodeVersion}，OpenClaw 建议使用 >= 22.x。`);
  }

  results.clawInstalled = openclawExists();
  results.clawPath = resolveOpenClawBinary();
  if (!results.clawInstalled) {
    results.errors.push(getOpenClawLookupHint());
  }
  results.openclawPackageDir = resolveOpenClawPackageDir();
  results.pluginPackages = detectPluginPackages(results.openclawPackageDir);

  results.configExists = fs.existsSync(CONFIG_PATH);

  if (results.configExists && hasLegacyGatewaysKey()) {
    results.errors.push('检测到旧版 OpenClaw 配置（根级 gateways 字段），启动安装时会自动迁移');
  }

  if (!fs.existsSync(MAIN_AGENT_AUTH_PROFILES_PATH)) {
    results.warnings.push(
      `检测到 OpenClaw 主 Agent 尚未配置模型鉴权：${MAIN_AGENT_AUTH_PROFILES_PATH} 不存在。即使安装成功，AI 回复仍可能失败。`
    );
  }

  results.gatewayReachable = await checkGateway();

  const pendingState = stateModule.loadState();
  if (pendingState) {
    results.hasPendingState = true;
    results.pendingState = pendingState;
  }

  return results;
}

function getNodeMajorVersion(version) {
  const parsed = parseInt(String(version || '').split('.')[0], 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function detectPluginPackages(packageDir) {
  const plugins = {
    feishu: { detected: false, packagePath: null },
    wecom: { detected: false, packagePath: null },
  };

  if (!packageDir) {
    return plugins;
  }

  const candidates = {
    feishu: `${packageDir}/node_modules/@openclaw/feishu/package.json`,
    wecom: `${packageDir}/node_modules/@wecom/wecom-openclaw-plugin/package.json`,
  };

  for (const [channel, pluginPath] of Object.entries(candidates)) {
    if (fs.existsSync(pluginPath)) {
      plugins[channel] = {
        detected: true,
        packagePath: pluginPath,
      };
    }
  }

  return plugins;
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

module.exports = { runPreflight, checkGateway, detectPluginPackages, getNodeMajorVersion };
