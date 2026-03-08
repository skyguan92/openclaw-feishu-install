const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CONFIG_PATH } = require('../utils/paths');

const OPENCLAW_BIN = 'openclaw';
const WINDOWS_SHELL = process.env.ComSpec || 'cmd.exe';
let resolvedOpenClawBin = null;

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function readFirstResolvedCommand(command) {
  try {
    if (process.platform === 'win32') {
      const result = spawnSync(WINDOWS_SHELL, ['/d', '/s', '/c', 'where', command], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      if (result.status !== 0) {
        return null;
      }
      return String(result.stdout || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line && fs.existsSync(line)) || null;
    }

    const output = execFileSync('which', [command], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const resolved = String(output).trim();
    return resolved && fs.existsSync(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

function getNvmOpenClawCandidates() {
  const nvmVersionsDir = process.env.NVM_DIR
    ? path.join(process.env.NVM_DIR, 'versions', 'node')
    : path.join(os.homedir(), '.nvm', 'versions', 'node');

  try {
    return fs.readdirSync(nvmVersionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(nvmVersionsDir, entry.name, 'bin', OPENCLAW_BIN))
      .reverse();
  } catch {
    return [];
  }
}

function getOpenClawCandidates() {
  const localBin = path.join(process.cwd(), 'node_modules', '.bin');
  const npmPrefixes = unique([
    process.env.npm_config_prefix,
    process.env.NPM_CONFIG_PREFIX,
  ]);

  const candidates = [
    process.env.OPENCLAW_BIN,
    readFirstResolvedCommand(OPENCLAW_BIN),
    path.join(localBin, process.platform === 'win32' ? `${OPENCLAW_BIN}.cmd` : OPENCLAW_BIN),
    path.join(localBin, OPENCLAW_BIN),
  ];

  for (const prefix of npmPrefixes) {
    candidates.push(path.join(prefix, process.platform === 'win32' ? `${OPENCLAW_BIN}.cmd` : OPENCLAW_BIN));
    if (process.platform === 'win32') {
      candidates.push(path.join(prefix, OPENCLAW_BIN));
    } else {
      candidates.push(path.join(prefix, 'bin', OPENCLAW_BIN));
    }
  }

  if (process.platform === 'win32') {
    candidates.push(
      process.env.APPDATA && path.join(process.env.APPDATA, 'npm', `${OPENCLAW_BIN}.cmd`),
      process.env.APPDATA && path.join(process.env.APPDATA, 'npm', OPENCLAW_BIN),
      process.env.USERPROFILE && path.join(process.env.USERPROFILE, 'AppData', 'Roaming', 'npm', `${OPENCLAW_BIN}.cmd`),
      process.env.USERPROFILE && path.join(process.env.USERPROFILE, 'AppData', 'Roaming', 'npm', OPENCLAW_BIN)
    );
  } else {
    candidates.push(
      '/usr/local/bin/openclaw',
      '/opt/homebrew/bin/openclaw',
      path.join(os.homedir(), '.npm-global', 'bin', OPENCLAW_BIN),
      path.join(os.homedir(), '.local', 'bin', OPENCLAW_BIN),
      ...getNvmOpenClawCandidates()
    );
  }

  return unique(candidates);
}

function resolveOpenClawBinary() {
  if (resolvedOpenClawBin && fs.existsSync(resolvedOpenClawBin)) {
    return resolvedOpenClawBin;
  }

  resolvedOpenClawBin = getOpenClawCandidates().find((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  }) || null;

  return resolvedOpenClawBin;
}

function getOpenClawLookupHint() {
  if (process.platform === 'win32') {
    return '未找到 openclaw CLI。请确认已安装，或设置 OPENCLAW_BIN；常见位置是 %APPDATA%\\npm\\openclaw.cmd。若从 schtasks/SSH 运行，也请确认该会话能读取用户级 PATH。';
  }

  return '未找到 openclaw CLI。请确认已安装，或设置 OPENCLAW_BIN；常见位置包括 /usr/local/bin/openclaw、/opt/homebrew/bin/openclaw、~/.npm-global/bin/openclaw。';
}

function openclawExists() {
  return Boolean(resolveOpenClawBinary());
}

function runOpenClaw(args, options = {}) {
  const openclawBin = resolveOpenClawBinary();
  if (!openclawBin) {
    throw new Error(getOpenClawLookupHint());
  }

  try {
    return runCommand(openclawBin, args, options).trim();
  } catch (err) {
    const stdout = (err.stdout || '').toString().trim();
    const stderr = (err.stderr || '').toString().trim();
    const detail = [stderr, stdout].filter(Boolean).join('\n');
    throw new Error(detail || err.message);
  }
}

function runCommand(command, args, options = {}) {
  if (process.platform === 'win32') {
    const result = spawnSync(WINDOWS_SHELL, ['/d', '/s', '/c', command, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: options.timeout || 60000,
      windowsHide: true,
    });

    if (result.error) {
      result.error.stdout = result.stdout || '';
      result.error.stderr = result.stderr || '';
      throw result.error;
    }

    if (result.status !== 0) {
      const error = new Error(
        (result.stderr || result.stdout || `Command failed with exit code ${result.status}`).trim()
      );
      error.stdout = result.stdout || '';
      error.stderr = result.stderr || '';
      error.status = result.status;
      throw error;
    }

    return result.stdout || '';
  }

  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeout || 60000,
  });
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
  getOpenClawLookupHint,
  hasLegacyGatewaysKey,
  openclawExists,
  repairLegacyConfig,
  resolveOpenClawBinary,
  runOpenClaw,
  runOpenClawJson,
  setConfigValue,
};
