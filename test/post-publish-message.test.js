const test = require('node:test');
const assert = require('node:assert/strict');

const { sendPostPublishMessage } = require('../src/automation/post-publish-message');

function createBus() {
  return {
    phases: [],
    logs: [],
    sendPhase(phase, status, message) {
      this.phases.push({ phase, status, message });
    },
    sendLog(message) {
      this.logs.push(message);
    },
  };
}

function createJsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
  };
}

async function runPostPublishMessage(options = {}) {
  const page = {};
  const bus = createBus();
  const calls = [];
  const originalFetch = global.fetch;

  global.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    const body = options.body ? JSON.parse(options.body) : null;

    calls.push({
      url: url.toString(),
      pathname: url.pathname,
      search: url.search,
      method: options.method || 'GET',
      body,
    });

    if (url.pathname.endsWith('/auth/v3/tenant_access_token/internal')) {
      return createJsonResponse(200, {
        code: 0,
        data: {
          tenant_access_token: 'tenant-token',
        },
      });
    }

    if (url.pathname.endsWith('/contact/v3/scopes')) {
      return createJsonResponse(200, {
        code: 0,
        data: {
          user_ids: ['ou_scope_user'],
        },
      });
    }

    if (url.pathname.endsWith('/im/v1/messages')) {
      const receiveIdType = url.searchParams.get('receive_id_type');
      if (receiveIdType === 'open_id' && body?.receive_id === 'ou_scope_user') {
        return createJsonResponse(200, {
          code: 0,
          data: {
            message_id: 'om_message_ok',
          },
        });
      }

      return createJsonResponse(400, {
        code: 99991663,
        msg: 'id not exist',
      });
    }

    throw new Error(`Unexpected fetch: ${url.toString()}`);
  };

  try {
    const result = await sendPostPublishMessage(page, bus, {
      appId: 'cli_test',
      appSecret: 'secret_test',
      appName: 'Test Bot',
      operatorUserId: '7616207849110130197',
      ...options,
    });

    return {
      result,
      bus,
      calls,
    };
  } finally {
    global.fetch = originalFetch;
  }
}

test('sendPostPublishMessage treats scopes data.user_ids ou_ values as open_id candidates', async () => {
  const { result, calls } = await runPostPublishMessage();

  assert.equal(result.route, 'scope_open_id');
  assert.equal(result.receiveId, 'ou_scope_user');
  assert.equal(result.receiveIdType, 'open_id');
  assert.equal(result.messageId, 'om_message_ok');
  assert.equal(result.operatorUserId, '7616207849110130197');

  const messageCall = calls.find((call) => call.pathname.endsWith('/im/v1/messages'));
  assert.ok(messageCall, 'expected a message send request');
  assert.equal(new URL(messageCall.url).searchParams.get('receive_id_type'), 'open_id');
  assert.equal(messageCall.body.receive_id, 'ou_scope_user');
});

test('sendPostPublishMessage returns pairing guidance when skipPairingApproval is disabled', async () => {
  const { result, bus } = await runPostPublishMessage();

  assert.equal(result.pairingRequired, true);
  assert.match(result.phaseDoneMessage, /pairing/i);
  assert.match(result.phaseDoneMessage, /回复/);
  assert.ok(
    bus.logs.some((entry) => entry.includes('openclaw pairing approve feishu <code>')),
    'expected follow-up log about pairing approve'
  );
});

test('sendPostPublishMessage returns direct-use guidance when skipPairingApproval is enabled', async () => {
  const { result, bus } = await runPostPublishMessage({
    skipPairingApproval: true,
  });

  assert.equal(result.pairingRequired, false);
  assert.match(result.phaseDoneMessage, /直接/);
  assert.ok(
    bus.logs.some((entry) => entry.includes('可以直接在这个会话里开始使用')),
    'expected direct-use guidance log'
  );
  assert.ok(
    !bus.logs.some((entry) => entry.includes('openclaw pairing approve feishu <code>')),
    'did not expect pairing approve guidance in direct-use mode'
  );
});

test('sendPostPublishMessage returns not_sent soft failure when all retries exhausted', async () => {
  const page = {};
  const bus = createBus();
  const originalFetch = global.fetch;

  global.fetch = async (input) => {
    const url = new URL(String(input));

    if (url.pathname.endsWith('/auth/v3/tenant_access_token/internal')) {
      return createJsonResponse(200, {
        code: 0,
        data: { tenant_access_token: 'tenant-token' },
      });
    }

    if (url.pathname.endsWith('/contact/v3/scopes')) {
      return createJsonResponse(400, { code: 99991400, msg: 'app not ready' });
    }

    if (url.pathname.endsWith('/im/v1/messages')) {
      return createJsonResponse(400, { code: 99991663, msg: 'id not exist' });
    }

    throw new Error(`Unexpected fetch: ${url.toString()}`);
  };

  try {
    const result = await sendPostPublishMessage(page, bus, {
      appId: 'cli_test',
      appSecret: 'secret_test',
      appName: 'Test Bot',
      operatorUserId: '7616207849110130197',
      retryDelaysMs: [],
    });

    assert.equal(result.route, 'not_sent');
    assert.equal(result.messageId, '');
    assert.equal(result.operatorUserId, '7616207849110130197');
    assert.match(result.phaseDoneMessage, /手动/);
    assert.ok(
      bus.logs.some((entry) => entry.includes('已知延迟')),
      'expected soft-failure log about known delay'
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('sendPostPublishMessage retries and succeeds when API becomes ready', async () => {
  const page = {};
  const bus = createBus();
  const originalFetch = global.fetch;
  let scopeCallCount = 0;

  global.fetch = async (input, fetchOptions = {}) => {
    const url = new URL(String(input));

    if (url.pathname.endsWith('/auth/v3/tenant_access_token/internal')) {
      return createJsonResponse(200, {
        code: 0,
        data: { tenant_access_token: 'tenant-token' },
      });
    }

    if (url.pathname.endsWith('/contact/v3/scopes')) {
      scopeCallCount++;
      if (scopeCallCount <= 2) {
        return createJsonResponse(400, { code: 99991400, msg: 'app not ready' });
      }
      return createJsonResponse(200, {
        code: 0,
        data: { user_ids: ['ou_retry_user'] },
      });
    }

    if (url.pathname.endsWith('/im/v1/messages')) {
      const body = fetchOptions.body ? JSON.parse(fetchOptions.body) : null;
      if (body?.receive_id === 'ou_retry_user') {
        return createJsonResponse(200, {
          code: 0,
          data: { message_id: 'om_retry_ok' },
        });
      }
      return createJsonResponse(400, { code: 99991663, msg: 'id not exist' });
    }

    throw new Error(`Unexpected fetch: ${url.toString()}`);
  };

  try {
    const result = await sendPostPublishMessage(page, bus, {
      appId: 'cli_test',
      appSecret: 'secret_test',
      appName: 'Test Bot',
      operatorUserId: '7616207849110130197',
      retryDelaysMs: [0, 0, 0],
    });

    assert.equal(result.route, 'scope_open_id');
    assert.equal(result.receiveId, 'ou_retry_user');
    assert.equal(result.messageId, 'om_retry_ok');
    assert.equal(scopeCallCount, 3, 'expected 3 scope calls (2 failures + 1 success)');
    assert.ok(
      bus.logs.some((entry) => entry.includes('重试')),
      'expected retry log'
    );
  } finally {
    global.fetch = originalFetch;
  }
});
