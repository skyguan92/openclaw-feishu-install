const os = require('os');
const path = require('path');
const { DEFAULT_CHANNEL } = require('../config/channels');

const OPENCLAW_HOME = path.join(os.homedir(), '.openclaw');
const LOG_DIR = path.join(OPENCLAW_HOME, 'logs');
const LEGACY_FEISHU_STATE_FILE = path.join(OPENCLAW_HOME, '.feishu-setup-state.json');
const STATE_FILE = path.join(OPENCLAW_HOME, '.channel-setup-state.json');
const CONFIG_PATH = path.join(OPENCLAW_HOME, 'openclaw.json');
const SCREENSHOT_DIR = path.join(LOG_DIR, 'setup-screenshots');

function getBrowserProfileDir(channel = DEFAULT_CHANNEL) {
  return path.join(OPENCLAW_HOME, 'browser-profile', channel);
}

module.exports = {
  CONFIG_PATH,
  getBrowserProfileDir,
  LEGACY_FEISHU_STATE_FILE,
  LOG_DIR,
  OPENCLAW_HOME,
  SCREENSHOT_DIR,
  STATE_FILE,
};
