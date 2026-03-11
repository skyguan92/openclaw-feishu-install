const test = require('node:test');
const assert = require('node:assert/strict');

const { mergeConfigObjects } = require('../src/config/openclaw-cli');
const {
  findMatchingPendingRequest,
  normalizePairingRequests,
  resolveApprovalTarget,
} = require('../src/config/pairing');

test('mergeConfigObjects preserves unrelated config while merging nested channel settings', () => {
  const current = {
    gateway: { port: 18789 },
    channels: {
      feishu: { enabled: true },
      wecom: { groupPolicy: 'pairing' },
    },
    models: {
      primary: { provider: 'minimax-cn' },
    },
  };
  const patch = {
    gateway: { mode: 'local' },
    channels: {
      wecom: {
        enabled: true,
        botId: 'bot-123',
        secret: 'secret-123',
        name: 'OpenClaw 助手',
      },
    },
  };

  assert.deepEqual(mergeConfigObjects(current, patch), {
    gateway: { port: 18789, mode: 'local' },
    channels: {
      feishu: { enabled: true },
      wecom: {
        groupPolicy: 'pairing',
        enabled: true,
        botId: 'bot-123',
        secret: 'secret-123',
        name: 'OpenClaw 助手',
      },
    },
    models: {
      primary: { provider: 'minimax-cn' },
    },
  });
});

test('normalizePairingRequests unwraps JSON payloads and preserves request records', () => {
  const requests = normalizePairingRequests({
    requests: [
      { channel: 'wecom', status: 'approved', sender: 'other-user' },
      { channel: 'wecom', status: 'pending', sender: 'ChiRuoJing', userId: 'wxid-123' },
    ],
  });

  assert.equal(requests.length, 2);
  assert.equal(requests[1].sender, 'ChiRuoJing');
});

test('findMatchingPendingRequest selects the expected tester only', () => {
  const request = findMatchingPendingRequest(
    [
      { channel: 'wecom', status: 'pending', sender: 'SomeoneElse', userId: 'wxid-999' },
      { channel: 'wecom', status: 'pending', sender: 'ChiRuoJing', userId: 'wxid-123' },
    ],
    {
      channel: 'wecom',
      expectedTesterName: 'ChiRuoJing',
      expectedTesterId: 'wxid-123',
    }
  );

  assert.equal(request.sender, 'ChiRuoJing');
  assert.equal(request.userId, 'wxid-123');
});

test('resolveApprovalTarget prefers sender for wecom and code for feishu', () => {
  assert.equal(
    resolveApprovalTarget('wecom', {
      sender: 'ChiRuoJing',
      userId: 'wxid-123',
      code: 'PAIR123',
    }),
    'ChiRuoJing'
  );
  assert.equal(
    resolveApprovalTarget('feishu', {
      sender: 'ou_abc',
      code: 'PAIR456',
    }),
    'PAIR456'
  );
});
