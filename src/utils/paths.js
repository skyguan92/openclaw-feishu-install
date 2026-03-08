const os = require('os');
const path = require('path');

const OPENCLAW_HOME = path.join(os.homedir(), '.openclaw');
const LOG_DIR = path.join(OPENCLAW_HOME, 'logs');
const STATE_FILE = path.join(OPENCLAW_HOME, '.feishu-setup-state.json');
const CONFIG_PATH = path.join(OPENCLAW_HOME, 'openclaw.json');
const SCREENSHOT_DIR = path.join(LOG_DIR, 'setup-screenshots');
const BROWSER_PROFILE_DIR = path.join(OPENCLAW_HOME, 'browser-profile', 'feishu');

module.exports = {
  BROWSER_PROFILE_DIR,
  CONFIG_PATH,
  LOG_DIR,
  OPENCLAW_HOME,
  SCREENSHOT_DIR,
  STATE_FILE,
};
