const { fetchLoginContext } = require('./login');

const FEISHU_OPEN_API_BASE = 'https://open.feishu.cn/open-apis';

async function sendPostPublishMessage(page, bus, options) {
  bus.sendPhase('post_publish_message', 'running', '正在给当前用户发送首条消息...');

  const operator = await resolveOperatorContext(page, bus, options);
  if (!operator.userId) {
    throw new Error('未获取到当前飞书操作者 userId，无法自动发送首条消息');
  }

  const tenantAccessToken = await getTenantAccessToken(options.appId, options.appSecret);
  const messageText = buildWelcomeMessage(options);
  const attemptErrors = [];

  try {
    const scopedTarget = await resolveScopedMessageTarget(tenantAccessToken, operator.userId, bus);
    if (scopedTarget && scopedTarget.openId) {
      const result = await createTextMessage(tenantAccessToken, 'open_id', scopedTarget.openId, messageText);
      bus.sendLog(`已通过 contact/v3/scopes 定位到 open_id 并发送首条消息: ${scopedTarget.openId}`);
      return {
        route: 'scope_open_id',
        receiveId: scopedTarget.openId,
        receiveIdType: 'open_id',
        messageId: result.message_id || '',
        operatorUserId: operator.userId,
      };
    }

    attemptErrors.push('contact/v3/scopes 未能唯一定位当前操作者');
  } catch (err) {
    attemptErrors.push(`contact/v3/scopes 失败: ${err.message}`);
    bus.sendLog(`通过 contact/v3/scopes 获取 open_id 失败，准备回退到 user_id 直发: ${err.message}`);
  }

  try {
    const result = await createTextMessage(tenantAccessToken, 'user_id', operator.userId, messageText);
    bus.sendLog(`已回退为 user_id 直发首条消息: ${operator.userId}`);
    return {
      route: 'user_id',
      receiveId: operator.userId,
      receiveIdType: 'user_id',
      messageId: result.message_id || '',
      operatorUserId: operator.userId,
    };
  } catch (err) {
    attemptErrors.push(`user_id 直发失败: ${err.message}`);
  }

  throw new Error(`发送首条消息失败：${attemptErrors.join('；')}`);
}

async function resolveOperatorContext(page, bus, options) {
  if (options.operatorUserId) {
    return {
      userId: options.operatorUserId,
      tenantId: options.operatorTenantId || '',
    };
  }

  const loginContext = await fetchLoginContext(page, bus);
  return {
    userId: loginContext?.userId || '',
    tenantId: loginContext?.tenantId || '',
  };
}

async function getTenantAccessToken(appId, appSecret) {
  const data = await requestFeishuJson('/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    body: {
      app_id: appId,
      app_secret: appSecret,
    },
  });

  return data.tenant_access_token;
}

async function resolveScopedMessageTarget(tenantAccessToken, operatorUserId, bus) {
  const members = await listScopeMembers(tenantAccessToken);
  if (!members.length) {
    throw new Error('contact/v3/scopes 未返回任何可见用户');
  }

  bus.sendLog(`contact/v3/scopes 返回 ${members.length} 个候选用户`);
  const matched = members.find((member) => member.userId && member.userId === operatorUserId);
  if (matched) {
    return matched;
  }

  if (members.length === 1) {
    return members[0];
  }

  return null;
}

async function listScopeMembers(tenantAccessToken) {
  const members = [];
  const seen = new Set();
  let pageToken = '';

  while (true) {
    const data = await requestFeishuJson('/contact/v3/scopes', {
      method: 'GET',
      token: tenantAccessToken,
      query: {
        page_size: '200',
        ...(pageToken ? { page_token: pageToken } : {}),
      },
    });

    const pageMembers = extractScopeMembers(data);
    for (const member of pageMembers) {
      const key = `${member.openId || ''}:${member.userId || ''}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      members.push(member);
    }

    if (!data.has_more || !data.page_token) {
      break;
    }

    pageToken = data.page_token;
  }

  return members;
}

function extractScopeMembers(data) {
  const results = [];
  const seen = new Set();

  function walk(node, depth = 0) {
    if (!node || depth > 6) {
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        walk(item, depth + 1);
      }
      return;
    }

    if (typeof node !== 'object') {
      return;
    }

    const openId = node.open_id || node.openId || '';
    const userId = node.user_id || node.userId || node.employee_id || node.employeeId || '';
    const name = node.name || node.display_name || node.displayName || node.en_name || node.enName || '';

    if (openId) {
      const key = `${openId}:${userId}`;
      if (!seen.has(key)) {
        seen.add(key);
        results.push({
          openId,
          userId,
          name,
        });
      }
    }

    for (const value of Object.values(node)) {
      walk(value, depth + 1);
    }
  }

  walk(data);
  return results;
}

async function createTextMessage(tenantAccessToken, receiveIdType, receiveId, text) {
  return requestFeishuJson('/im/v1/messages', {
    method: 'POST',
    token: tenantAccessToken,
    query: {
      receive_id_type: receiveIdType,
    },
    body: {
      receive_id: receiveId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    },
  });
}

function buildWelcomeMessage(options) {
  const botName = options.botName || options.appName || 'OpenClaw';
  if (options.skipPairingApproval) {
    return `${botName} 已安装完成。后续直接在这个会话里回复任意一句话，即可开始使用。`;
  }

  return `${botName} 已安装完成。你已经收到机器人的首条私信，后续直接在这个会话里回复任意一句话，即可继续首次配对。`;
}

async function requestFeishuJson(path, options = {}) {
  const url = new URL(`${FEISHU_OPEN_API_BASE}${path}`);
  for (const [key, value] of Object.entries(options.query || {})) {
    if (value != null && value !== '') {
      url.searchParams.set(key, value);
    }
  }

  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: {
      Accept: 'application/json, text/plain, */*',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  if (!payload || payload.code !== 0) {
    throw new Error(formatFeishuError(payload));
  }

  return payload.data || {};
}

function formatFeishuError(payload) {
  if (!payload) {
    return '返回空响应';
  }

  const parts = [];
  if (payload.code != null) {
    parts.push(`code=${payload.code}`);
  }
  if (payload.msg) {
    parts.push(payload.msg);
  }
  if (payload.error?.message) {
    parts.push(payload.error.message);
  }
  return parts.join(' | ') || '未知错误';
}

module.exports = {
  sendPostPublishMessage,
};
