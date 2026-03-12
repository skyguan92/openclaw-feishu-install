const DEFAULT_FEISHU_BASE_URL = 'https://open.feishu.cn';

function normalizeFeishuBaseUrl(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return DEFAULT_FEISHU_BASE_URL;
  }

  const withProtocol = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  return withProtocol.replace(/\/+$/, '');
}

function getFeishuBaseUrl() {
  return normalizeFeishuBaseUrl(process.env.OPENCLAW_FEISHU_BASE_URL);
}

function buildFeishuUrl(pathname = '') {
  const normalizedPath = String(pathname || '').replace(/^\/+/, '');
  return new URL(normalizedPath, `${getFeishuBaseUrl()}/`).toString();
}

function getFeishuHost() {
  return new URL(getFeishuBaseUrl()).hostname;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getLoggedInUrlPattern() {
  return new RegExp(`${escapeRegex(getFeishuHost())}\\/app\\/?$`);
}

function isFeishuDeveloperApiUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === getFeishuHost()
      && parsed.pathname.startsWith('/developers/v1/');
  } catch {
    return false;
  }
}

function simplifyFeishuUrl(url) {
  const base = getFeishuBaseUrl();
  return String(url).replace(new RegExp(`^${escapeRegex(base)}`), '');
}

module.exports = {
  DEFAULT_FEISHU_BASE_URL,
  buildFeishuUrl,
  getFeishuBaseUrl,
  getFeishuHost,
  getLoggedInUrlPattern,
  isFeishuDeveloperApiUrl,
  normalizeFeishuBaseUrl,
  simplifyFeishuUrl,
};
