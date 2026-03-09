const fs = require('fs');
const path = require('path');
const {
  LEGACY_FEISHU_STATE_FILE,
  STATE_FILE,
} = require('../utils/paths');
const { DEFAULT_CHANNEL } = require('./channels');

function readStateFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      return parsed && typeof parsed === 'object' ? parsed : null;
    }
  } catch {
    // corrupted state
  }

  return null;
}

function normalizeStateShape(state) {
  if (!state || typeof state !== 'object') {
    return null;
  }

  return {
    channel: state.channel || DEFAULT_CHANNEL,
    ...state,
  };
}

function loadState(options = {}) {
  const preferredChannel = options.channel || null;
  const current = normalizeStateShape(readStateFile(STATE_FILE));
  if (current) {
    return current;
  }

  if (!preferredChannel || preferredChannel === 'feishu') {
    const legacyFeishu = normalizeStateShape(readStateFile(LEGACY_FEISHU_STATE_FILE));
    if (legacyFeishu) {
      return {
        channel: 'feishu',
        ...legacyFeishu,
      };
    }
  }

  return null;
}

function saveState(state) {
  const dir = path.dirname(STATE_FILE);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify(normalizeStateShape(state), null, 2)
  );
}

function clearState() {
  let cleared = false;

  for (const filePath of [STATE_FILE, LEGACY_FEISHU_STATE_FILE]) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        cleared = true;
      }
    } catch {
      // ignore cleanup failures
    }
  }

  return cleared;
}

module.exports = {
  clearState,
  loadState,
  saveState,
};
