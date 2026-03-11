const { runOpenClaw, runOpenClawJson } = require('./openclaw-cli');

const ARRAY_KEYS = ['requests', 'pendingRequests', 'pending', 'items', 'entries'];
const PENDING_STATUSES = new Set(['', 'pending', 'requested']);
const SAFE_APPROVAL_TARGET_PATTERN = /^[\p{L}\p{N}_.\- @]+$/u;

function normalizeString(value) {
  if (value == null) {
    return '';
  }

  return String(value).trim();
}

function normalizeComparable(value) {
  return normalizeString(value).toLowerCase();
}

function normalizePairingRequests(payload) {
  if (Array.isArray(payload)) {
    return payload.filter((entry) => entry && typeof entry === 'object');
  }

  if (!payload || typeof payload !== 'object') {
    return [];
  }

  for (const key of ARRAY_KEYS) {
    if (Array.isArray(payload[key])) {
      return normalizePairingRequests(payload[key]);
    }
  }

  if (payload.data && typeof payload.data === 'object') {
    return normalizePairingRequests(payload.data);
  }

  return [];
}

function getFirstValue(request, keys) {
  for (const key of keys) {
    const value = normalizeString(request && request[key]);
    if (value) {
      return value;
    }
  }
  return '';
}

function getRequestChannel(request) {
  return normalizeComparable(getFirstValue(request, ['channel', 'provider', 'source', 'type']));
}

function getRequestStatus(request) {
  return normalizeComparable(getFirstValue(request, ['status', 'state']));
}

function getRequestDisplayName(request) {
  return getFirstValue(request, ['sender', 'senderName', 'name', 'displayName', 'userName', 'username']);
}

function getRequestStableId(request) {
  return getFirstValue(request, ['senderId', 'userId', 'fromUserId', 'openUserId', 'unionId', 'id']);
}

function getRequestCode(request) {
  return getFirstValue(request, ['code', 'pairingCode', 'requestCode']);
}

function matchesExpectedTester(request, options = {}) {
  const expectedTesterId = normalizeComparable(options.expectedTesterId);
  const expectedTesterName = normalizeComparable(options.expectedTesterName);
  const requestId = normalizeComparable(getRequestStableId(request));
  const requestName = normalizeComparable(getRequestDisplayName(request));

  if (expectedTesterId) {
    return Boolean(requestId) && expectedTesterId === requestId;
  }

  if (expectedTesterName) {
    return Boolean(requestName) && expectedTesterName === requestName;
  }

  return false;
}

function isPendingForChannel(request, channel) {
  const requestChannel = getRequestChannel(request);
  const requestStatus = getRequestStatus(request);
  return requestChannel === normalizeComparable(channel) && PENDING_STATUSES.has(requestStatus);
}

function findMatchingPendingRequest(requests, options = {}) {
  const filtered = requests.filter((request) => isPendingForChannel(request, options.channel));
  return filtered.find((request) => matchesExpectedTester(request, options)) || null;
}

function describeRequest(request) {
  const displayName = getRequestDisplayName(request) || 'unknown';
  const stableId = getRequestStableId(request);
  const code = getRequestCode(request);
  return [displayName, stableId, code].filter(Boolean).join(' / ');
}

function resolveApprovalTarget(channel, request) {
  if (normalizeComparable(channel) === 'wecom') {
    return getFirstValue(request, ['sender', 'senderName', 'userName', 'userId', 'senderId', 'code']);
  }

  return getFirstValue(request, ['code', 'pairingCode', 'requestCode', 'sender', 'userId']);
}

function listPairings() {
  return normalizePairingRequests(runOpenClawJson(['pairing', 'list'], { timeout: 15000 }));
}

function normalizeApprovalTarget(approvalTarget) {
  const normalized = normalizeString(approvalTarget);
  if (!normalized) {
    throw new Error('pairing approve 参数不能为空');
  }

  if (!SAFE_APPROVAL_TARGET_PATTERN.test(normalized)) {
    throw new Error('pairing approve 参数包含不安全字符，请改用稳定 ID/配对码或手动批准');
  }

  return normalized;
}

function approvePairing(channel, approvalTarget) {
  const normalizedApprovalTarget = normalizeApprovalTarget(approvalTarget);
  const attempts = [
    ['pairing', 'approve', channel, normalizedApprovalTarget],
    ['pairing', 'approve', normalizedApprovalTarget],
  ];

  let lastError = null;
  for (const args of attempts) {
    try {
      return runOpenClaw(args, { timeout: 30000 });
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error('pairing approve failed');
}

async function waitForExpectedPairingAndApprove(bus, options = {}) {
  const channel = options.channel || 'wecom';
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 90000;
  const pollIntervalMs = Number.isFinite(options.pollIntervalMs) ? options.pollIntervalMs : 3000;
  const expectedTesterName = normalizeString(options.expectedTesterName);
  const expectedTesterId = normalizeString(options.expectedTesterId);
  const listPairingsFn = options.listPairings || listPairings;
  const approvePairingFn = options.approvePairing || approvePairing;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  if (!expectedTesterName && !expectedTesterId) {
    return { status: 'skipped' };
  }

  const deadline = Date.now() + timeoutMs;
  const targetLabel = [expectedTesterName, expectedTesterId].filter(Boolean).join(' / ');
  let lastObservedPending = null;
  let mismatchLogged = false;

  bus.sendLog(`已开启 ${channel} pairing watcher，等待目标 tester: ${targetLabel}`);

  while (Date.now() < deadline) {
    const requests = normalizePairingRequests(await Promise.resolve(listPairingsFn(channel)));
    const matchedRequest = findMatchingPendingRequest(requests, {
      channel,
      expectedTesterName,
      expectedTesterId,
    });

    if (matchedRequest) {
      const approvalTarget = resolveApprovalTarget(channel, matchedRequest);
      if (!approvalTarget) {
        throw new Error(`检测到目标 ${channel} pairing，但无法推导 approve 参数`);
      }
      bus.sendLog(`检测到目标 ${channel} pairing request: ${describeRequest(matchedRequest)}`);
      await Promise.resolve(approvePairingFn(channel, approvalTarget, matchedRequest));
      bus.sendLog(`已自动批准 ${channel} pairing: ${approvalTarget}`);
      return {
        status: 'approved',
        approvedTarget: approvalTarget,
        matchedRequest: {
          channel,
          displayName: getRequestDisplayName(matchedRequest),
          stableId: getRequestStableId(matchedRequest),
          code: getRequestCode(matchedRequest),
        },
      };
    }

    const firstPendingRequest = requests.find((request) => isPendingForChannel(request, channel));
    if (firstPendingRequest) {
      lastObservedPending = {
        channel,
        displayName: getRequestDisplayName(firstPendingRequest),
        stableId: getRequestStableId(firstPendingRequest),
        code: getRequestCode(firstPendingRequest),
      };
      if (!mismatchLogged) {
        bus.sendLog(`检测到未命中的 ${channel} pairing request，继续等待目标 tester`);
        mismatchLogged = true;
      }
    }

    await sleep(pollIntervalMs);
  }

  bus.sendLog(`pairing watcher 超时：窗口内未自动批准目标 ${channel} tester`);
  return {
    status: 'timeout',
    lastObservedPending,
  };
}

module.exports = {
  approvePairing,
  describeRequest,
  findMatchingPendingRequest,
  listPairings,
  normalizePairingRequests,
  resolveApprovalTarget,
  waitForExpectedPairingAndApprove,
};
