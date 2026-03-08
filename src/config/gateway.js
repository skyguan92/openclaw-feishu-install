const {
  openclawExists,
  repairLegacyConfig,
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
    bus.sendLog('openclaw CLI 未安装，跳过 Gateway 自动启动');
    return;
  }

  repairLegacyConfig(bus);

  const sanitizedExistingLaunchAgent = sanitizeGatewayLaunchAgent(bus);
  if (sanitizedExistingLaunchAgent) {
    reloadGatewayLaunchAgent(bus);
  }

  let status = getGatewayStatus();
  if (isGatewayReady(status)) {
    bus.sendLog('Gateway 已在运行并通过 RPC 检查');
    return;
  }

  let targetPort = status?.gateway?.port || 18789;
  if (shouldMoveGatewayPort(status)) {
    const nextPort = await findAvailablePort(targetPort + 1);
    if (nextPort !== targetPort) {
      targetPort = nextPort;
      setConfigValue('gateway.port', targetPort);
      bus.sendLog(`检测到默认 Gateway 端口被其他进程占用，已切换到空闲端口 ${targetPort}`);
    }
  }

  bus.sendLog(`执行 Gateway 安装/重装（port=${targetPort}）...`);
  const installResult = runOpenClawJson(
    ['gateway', 'install', '--force', '--port', String(targetPort)],
    { timeout: 120000 }
  );
  for (const warning of installResult.warnings || []) {
    bus.sendLog(`Gateway 提示: ${warning}`);
  }

  if (sanitizeGatewayLaunchAgent(bus)) {
    reloadGatewayLaunchAgent(bus);
  }

  const maxRetries = 20;
  for (let i = 0; i < maxRetries; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    status = getGatewayStatus();
    if (isGatewayReady(status)) {
      bus.sendLog('Gateway 已启动并通过 RPC 检查');
      return;
    }

    const runtime = status?.service?.runtime?.status || 'unknown';
    bus.sendLog(`等待 Gateway 就绪... (${i + 1}/${maxRetries}, runtime=${runtime})`);
  }

  throw new Error('Gateway 启动超时，请运行 openclaw gateway status 检查服务状态');
}

function getGatewayStatus() {
  return runOpenClawJson(['gateway', 'status'], { timeout: 30000 });
}

function shouldMoveGatewayPort(status) {
  return Boolean(
    status &&
    status.port &&
    status.port.status === 'busy' &&
    !(status.rpc && status.rpc.ok)
  );
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
  return Boolean(
    status &&
    status.service &&
    status.service.runtime &&
    status.service.runtime.status === 'running' &&
    status.rpc &&
    status.rpc.ok
  );
}

function sanitizeGatewayLaunchAgent(bus) {
  if (process.platform !== 'darwin' || !fs.existsSync(GATEWAY_LAUNCH_AGENT_PATH)) {
    return false;
  }

  const plist = readLaunchAgentPlist();
  const env = { ...(plist.EnvironmentVariables || {}) };
  let changed = false;

  for (const key of PROXY_ENV_KEYS) {
    if (Object.prototype.hasOwnProperty.call(env, key)) {
      delete env[key];
      changed = true;
    }
  }

  const noProxyKey = Object.prototype.hasOwnProperty.call(env, 'NO_PROXY') ? 'NO_PROXY' : 'no_proxy';
  const currentNoProxy = String(env[noProxyKey] || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const mergedNoProxy = Array.from(new Set([...currentNoProxy, ...REQUIRED_NO_PROXY_HOSTS]));
  if (mergedNoProxy.join(',') !== currentNoProxy.join(',')) {
    env[noProxyKey] = mergedNoProxy.join(',');
    changed = true;
  }

  if (!changed) {
    return false;
  }

  plist.EnvironmentVariables = env;
  writeLaunchAgentPlist(plist);
  if (bus) {
    bus.sendLog('已移除 Gateway 服务中的代理环境变量，并补充 NO_PROXY=open.feishu.cn');
  }
  return true;
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
    } catch {}
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
  } catch {}

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
