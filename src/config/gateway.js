const {
  CONFIG_PATH,
  getOpenClawLookupHint,
  openclawExists,
  repairLegacyConfig,
  resolveOpenClawBinary,
  runOpenClaw,
  runOpenClawJson,
  setConfigValue,
} = require('./openclaw-cli');
const { execFileSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const GATEWAY_LABEL = 'ai.openclaw.gateway';
const GATEWAY_LAUNCH_AGENT_PATH = path.join(
  os.homedir(),
  'Library',
  'LaunchAgents',
  `${GATEWAY_LABEL}.plist`
);
const PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
];
const REQUIRED_NO_PROXY_HOSTS = ['127.0.0.1', 'localhost', 'open.feishu.cn'];

async function restartGateway(bus) {
  bus.sendLog('检查 OpenClaw Gateway 状态...');

  if (!openclawExists()) {
    bus.sendLog(getOpenClawLookupHint());
    bus.sendLog('未找到 OpenClaw CLI，跳过 Gateway 自动启动');
    return;
  }

  const openclawBin = resolveOpenClawBinary();
  if (openclawBin) {
    bus.sendLog(`使用 OpenClaw CLI: ${openclawBin}`);
  }

  repairLegacyConfig(bus);

  let status = safeGetGatewayStatus();
  let targetPort = extractGatewayPort(status) || 18789;

  if (shouldMoveGatewayPort(status)) {
    const nextPort = await findAvailablePort(targetPort + 1);
    if (nextPort !== targetPort) {
      targetPort = nextPort;
      setConfigValue('gateway.port', targetPort);
      bus.sendLog(`检测到默认 Gateway 端口被其他进程占用，已切换到空闲端口 ${targetPort}`);
      status = safeGetGatewayStatus();
    }
  }

  const configSnapshot = readConfigSnapshot();
  const launchAgentEnvSnapshot = captureGatewayLaunchAgentEnvironment();

  if (hasInstalledGatewayService(status)) {
    bus.sendLog('尝试重载现有 Gateway 服务...');
    const restarted = await tryRestartExistingGateway(bus, status);
    if (restarted) {
      return;
    }

    bus.sendLog('现有 Gateway 服务重载后仍未就绪，准备执行安装修复...');
  } else {
    bus.sendLog('未检测到现有 Gateway 服务，准备执行安装...');
  }

  bus.sendLog(`执行 Gateway 安装/重装（port=${targetPort}）...`);
  const installResult = runOpenClawJson(
    ['gateway', 'install', '--force', '--port', String(targetPort)],
    { timeout: 120000 }
  );
  for (const warning of installResult.warnings || []) {
    bus.sendLog(`Gateway 提示: ${warning}`);
  }

  restoreConfigSnapshot(bus, configSnapshot);

  if (process.platform === 'darwin') {
    applyGatewayLaunchAgentEnvironment(bus, launchAgentEnvSnapshot);
    reloadGatewayLaunchAgent(bus);
  } else {
    startExistingGatewayService(bus);
  }

  status = await waitForGatewayReady(bus);
  if (isGatewayReady(status)) {
    bus.sendLog('Gateway 已启动并通过 RPC 检查');
    return;
  }

  throw new Error('Gateway 启动超时，请运行 openclaw gateway status 检查服务状态');
}

function getGatewayStatus() {
  return runOpenClawJson(['gateway', 'status'], { timeout: 30000 });
}

function safeGetGatewayStatus() {
  try {
    return getGatewayStatus();
  } catch {
    return null;
  }
}

function shouldMoveGatewayPort(status) {
  return Boolean(
    status &&
    status.port &&
    status.port.status === 'busy' &&
    !isGatewayReady(status)
  );
}

function hasInstalledGatewayService(status) {
  if (process.platform === 'darwin') {
    return fs.existsSync(GATEWAY_LAUNCH_AGENT_PATH);
  }

  return Boolean(
    status &&
    (
      status.service
      || status.gateway
      || status.port
      || status.rpc
      || extractGatewayPid(status)
    )
  );
}

async function tryRestartExistingGateway(bus, status) {
  try {
    if (process.platform === 'darwin' && fs.existsSync(GATEWAY_LAUNCH_AGENT_PATH)) {
      applyGatewayLaunchAgentEnvironment(bus);
      reloadGatewayLaunchAgent(bus);
      return isGatewayReady(await waitForGatewayReady(bus, { maxRetries: 15 }));
    }

    if (process.platform === 'win32') {
      const pid = extractGatewayPid(status);
      if (pid) {
        stopGatewayProcess(bus, pid);
      } else {
        bus.sendLog('未从 Gateway 状态中提取到 PID，尝试执行 openclaw gateway restart');
        try {
          runOpenClaw(['gateway', 'restart'], { timeout: 60000 });
        } catch (err) {
          bus.sendLog(`gateway restart 失败，改为执行 gateway start: ${err.message}`);
        }
      }

      startExistingGatewayService(bus);
      return isGatewayReady(await waitForGatewayReady(bus, { maxRetries: 15 }));
    }

    runOpenClaw(['gateway', 'restart'], { timeout: 60000 });
    return isGatewayReady(await waitForGatewayReady(bus, { maxRetries: 15 }));
  } catch (err) {
    bus.sendLog(`Gateway 重载失败: ${err.message}`);
    return false;
  }
}

function startExistingGatewayService(bus) {
  try {
    runOpenClaw(['gateway', 'start'], { timeout: 60000 });
    bus.sendLog('已触发 Gateway start');
    return true;
  } catch (err) {
    if (bus) {
      bus.sendLog(`Gateway start 失败: ${err.message}`);
    }
    return false;
  }
}

function stopGatewayProcess(bus, pid) {
  if (!pid) {
    return false;
  }

  try {
    execFileSync('taskkill', ['/F', '/PID', String(pid)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (bus) {
      bus.sendLog(`已结束旧 Gateway 进程 PID=${pid}`);
    }
    return true;
  } catch (err) {
    if (bus) {
      const detail = [String(err.stderr || '').trim(), String(err.stdout || '').trim()]
        .filter(Boolean)
        .join('\n');
      bus.sendLog(`结束旧 Gateway 进程失败: ${detail || err.message}`);
    }
    return false;
  }
}

async function waitForGatewayReady(bus, options = {}) {
  const maxRetries = options.maxRetries || 20;
  const delayMs = options.delayMs || 2000;

  for (let i = 0; i < maxRetries; i += 1) {
    if (i > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    const status = safeGetGatewayStatus();
    if (isGatewayReady(status)) {
      return status;
    }

    if (bus) {
      const runtime = extractGatewayRuntimeStatus(status);
      const rpc = status?.rpc?.ok ? 'ok' : 'pending';
      bus.sendLog(`等待 Gateway 就绪... (${i + 1}/${maxRetries}, runtime=${runtime}, rpc=${rpc})`);
    }
  }

  return safeGetGatewayStatus();
}

async function findAvailablePort(startPort, maxAttempts = 50) {
  let port = startPort;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (await isPortAvailable(port)) {
      return port;
    }
    port += 1;
  }
  throw new Error(`未找到可用的 Gateway 端口（从 ${startPort} 起尝试了 ${maxAttempts} 个端口）`);
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on('error', () => resolve(false));
    server.listen({ host: '127.0.0.1', port }, () => {
      server.close(() => resolve(true));
    });
  });
}

function isGatewayReady(status) {
  return Boolean(status?.rpc?.ok);
}

function extractGatewayPort(status) {
  const candidates = [
    status?.gateway?.port,
    status?.service?.port,
    status?.rpc?.port,
    status?.port?.port,
    status?.port?.desired,
    status?.port?.value,
    typeof status?.port === 'number' ? status.port : null,
  ];

  return candidates.find((value) => Number.isInteger(value) && value > 0) || null;
}

function extractGatewayPid(status) {
  const candidates = [
    status?.service?.process?.pid,
    status?.service?.runtime?.pid,
    status?.process?.pid,
    status?.gateway?.pid,
    status?.runtime?.pid,
  ];

  return candidates.find((value) => Number.isInteger(value) && value > 0) || null;
}

function extractGatewayRuntimeStatus(status) {
  return status?.service?.runtime?.status
    || status?.runtime?.status
    || status?.service?.status
    || 'unknown';
}

function readConfigSnapshot() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function restoreConfigSnapshot(bus, snapshot) {
  if (!snapshot || !fs.existsSync(CONFIG_PATH)) {
    return false;
  }

  let current = null;
  try {
    current = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return false;
  }

  const merged = mergeConfigPreferSnapshot(snapshot, current);
  if (JSON.stringify(merged) === JSON.stringify(current)) {
    return false;
  }

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
  if (bus) {
    bus.sendLog('已恢复 Gateway install 前的 OpenClaw 配置，避免覆盖已有模型/密钥设置');
  }
  return true;
}

function mergeConfigPreferSnapshot(snapshotValue, currentValue) {
  if (Array.isArray(snapshotValue)) {
    return snapshotValue.slice();
  }

  if (isPlainObject(snapshotValue) && isPlainObject(currentValue)) {
    const merged = { ...currentValue };
    for (const key of Object.keys(snapshotValue)) {
      if (Object.prototype.hasOwnProperty.call(currentValue, key)) {
        merged[key] = mergeConfigPreferSnapshot(snapshotValue[key], currentValue[key]);
      } else {
        merged[key] = snapshotValue[key];
      }
    }
    return merged;
  }

  return snapshotValue;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function captureGatewayLaunchAgentEnvironment() {
  if (process.platform !== 'darwin' || !fs.existsSync(GATEWAY_LAUNCH_AGENT_PATH)) {
    return null;
  }

  try {
    const plist = readLaunchAgentPlist();
    return { ...(plist.EnvironmentVariables || {}) };
  } catch {
    return null;
  }
}

function applyGatewayLaunchAgentEnvironment(bus, preservedEnv = null) {
  if (process.platform !== 'darwin' || !fs.existsSync(GATEWAY_LAUNCH_AGENT_PATH)) {
    return false;
  }

  const plist = readLaunchAgentPlist();
  const currentEnv = { ...(plist.EnvironmentVariables || {}) };
  const mergedEnv = sanitizeGatewayEnvironment({
    ...currentEnv,
    ...(preservedEnv || {}),
  });

  if (JSON.stringify(mergedEnv) === JSON.stringify(currentEnv)) {
    return false;
  }

  plist.EnvironmentVariables = mergedEnv;
  writeLaunchAgentPlist(plist);

  if (bus) {
    if (preservedEnv && Object.keys(preservedEnv).length > 0) {
      bus.sendLog('已恢复 Gateway LaunchAgent 中的自定义环境变量');
    } else {
      bus.sendLog('已移除 Gateway 服务中的代理环境变量，并补充 NO_PROXY=open.feishu.cn');
    }
  }

  return true;
}

function sanitizeGatewayEnvironment(env) {
  const sanitized = { ...(env || {}) };

  for (const key of PROXY_ENV_KEYS) {
    if (Object.prototype.hasOwnProperty.call(sanitized, key)) {
      delete sanitized[key];
    }
  }

  const noProxyKey = Object.prototype.hasOwnProperty.call(sanitized, 'NO_PROXY') ? 'NO_PROXY' : 'no_proxy';
  const currentNoProxy = String(sanitized[noProxyKey] || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  sanitized[noProxyKey] = Array.from(new Set([...currentNoProxy, ...REQUIRED_NO_PROXY_HOSTS])).join(',');

  return sanitized;
}

function readLaunchAgentPlist() {
  const output = execFileSync(
    'plutil',
    ['-convert', 'json', '-o', '-', GATEWAY_LAUNCH_AGENT_PATH],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
  return JSON.parse(output);
}

function writeLaunchAgentPlist(plist) {
  const tempPath = path.join(os.tmpdir(), `openclaw-gateway-${Date.now()}.json`);
  fs.writeFileSync(tempPath, JSON.stringify(plist, null, 2));
  try {
    execFileSync(
      'plutil',
      ['-convert', 'xml1', '-o', GATEWAY_LAUNCH_AGENT_PATH, tempPath],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
  } finally {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // ignore
    }
  }
}

function reloadGatewayLaunchAgent(bus) {
  if (process.platform !== 'darwin' || !fs.existsSync(GATEWAY_LAUNCH_AGENT_PATH)) {
    return;
  }

  const domain = `gui/${process.getuid()}`;
  try {
    execFileSync('launchctl', ['bootout', domain, GATEWAY_LAUNCH_AGENT_PATH], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    // ignore
  }

  execFileSync('launchctl', ['bootstrap', domain, GATEWAY_LAUNCH_AGENT_PATH], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  execFileSync('launchctl', ['kickstart', '-k', `${domain}/${GATEWAY_LABEL}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (bus) {
    bus.sendLog('Gateway LaunchAgent 已重载');
  }
}

module.exports = { restartGateway, getGatewayStatus, isGatewayReady };
