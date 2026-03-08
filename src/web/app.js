const PHASE_LABELS = {
  login: '登录飞书',
  create_app: '创建应用',
  credentials: '获取凭证',
  bot: '启用机器人',
  permissions: '配置权限',
  configure_openclaw: '配置 OpenClaw',
  restart_gateway: '重启 Gateway',
  events: '事件订阅',
  publish: '发布应用',
};

const PHASE_ORDER = [
  'login', 'create_app', 'credentials', 'bot',
  'permissions', 'configure_openclaw', 'restart_gateway', 'events', 'publish',
];

const ICONS = {
  pending: '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke-width="2"/></svg>',
  spinner: '<div class="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin"></div>',
  check: '<svg class="w-5 h-5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>',
  skip: '<svg class="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 5l7 7-7 7M5 5l7 7-7 7"/></svg>',
  error: '<svg class="w-5 h-5 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>',
};

let eventSource = null;
let pendingState = null;

window.addEventListener('DOMContentLoaded', async () => {
  renderPhaseSelects();
  await checkPreflight();
  await checkState();
});

async function checkPreflight() {
  try {
    const res = await fetch('/api/preflight');
    const data = await res.json();

    if (data.errors && data.errors.length > 0) {
      const alerts = document.getElementById('preflight-alerts');
      alerts.classList.remove('hidden');
      alerts.replaceChildren();
      for (const errMsg of data.errors) {
        const div = document.createElement('div');
        div.className = 'bg-red-900/30 border border-red-800 rounded-lg p-3 mb-2 text-red-300 text-sm';
        div.textContent = errMsg;
        alerts.appendChild(div);
      }
    }
  } catch {
    // preflight failed, continue anyway
  }
}

function renderPhaseSelects() {
  const startSelect = document.getElementById('start-phase');
  const endSelect = document.getElementById('end-phase');

  for (const phase of PHASE_ORDER) {
    const startOption = document.createElement('option');
    startOption.value = phase;
    startOption.textContent = PHASE_LABELS[phase];
    startSelect.appendChild(startOption);

    const endOption = document.createElement('option');
    endOption.value = phase;
    endOption.textContent = `执行到 ${PHASE_LABELS[phase]}`;
    endSelect.appendChild(endOption);
  }
}

async function checkState() {
  try {
    const res = await fetch('/api/state');
    const state = await res.json();

    pendingState = state && Object.keys(state).length > 0 ? state : null;
    applyStateToForm(state || {});

    const banner = document.getElementById('resume-banner');
    if (state && state.completedPhases && state.completedPhases.length > 0) {
      const detail = document.getElementById('resume-detail');
      const completed = state.completedPhases.map((phase) => PHASE_LABELS[phase] || phase).join(', ');
      const current = state.currentPhase ? `；当前停在: ${PHASE_LABELS[state.currentPhase] || state.currentPhase}` : '';
      detail.textContent = `已完成: ${completed}${current}`;
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }
  } catch {
    pendingState = null;
  }
}

function applyStateToForm(state) {
  if (state.appName) {
    document.getElementById('app-name').value = state.appName;
  }
  if (state.botName) {
    document.getElementById('bot-name').value = state.botName;
  }
  if (state.appDescription) {
    document.getElementById('app-desc').value = state.appDescription;
  }
  if (state.appId) {
    document.getElementById('existing-app-id').value = state.appId;
  }
}

function resumeInstall() {
  document.getElementById('resume-banner').classList.add('hidden');
  startInstall();
}

async function freshInstall() {
  await resetSavedState();
}

function startInstall() {
  clearFormError();

  const payload = {
    appName: document.getElementById('app-name').value.trim(),
    botName: document.getElementById('bot-name').value.trim(),
    appDescription: document.getElementById('app-desc').value.trim(),
    appId: document.getElementById('existing-app-id').value.trim(),
    appSecret: document.getElementById('existing-app-secret').value.trim(),
    startPhase: document.getElementById('start-phase').value,
    endPhase: document.getElementById('end-phase').value,
    clearLogin: document.getElementById('clear-login').checked,
  };

  const startIndex = payload.startPhase ? PHASE_ORDER.indexOf(payload.startPhase) : -1;
  const needsAppName = payload.startPhase === '' || startIndex <= PHASE_ORDER.indexOf('create_app');
  const needsBotName = payload.startPhase === '' || startIndex <= PHASE_ORDER.indexOf('bot');

  if (needsAppName && !payload.appName && !(pendingState && pendingState.appName)) {
    showFormError('执行创建应用相关步骤时，需要填写应用名称');
    return;
  }

  if (needsBotName && !payload.botName && !(pendingState && pendingState.botName)) {
    showFormError('执行机器人相关步骤时，需要填写机器人名称');
    return;
  }

  doStart(payload);
}

async function doStart(payload) {
  resetProgressView();
  document.getElementById('setup-form').classList.add('hidden');
  document.getElementById('progress-section').classList.remove('hidden');
  document.getElementById('action-buttons').classList.remove('hidden');

  renderPhases();
  connectSSE();

  try {
    const res = await fetch('/api/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || '启动失败');
    }

    addLog(`已启动，执行范围: ${data.startPhase} -> ${data.endPhase}`);
  } catch (err) {
    addLog('启动失败: ' + err.message);
    document.getElementById('setup-form').classList.remove('hidden');
    document.getElementById('progress-section').classList.add('hidden');
    document.getElementById('action-buttons').classList.add('hidden');
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
  }
}

function resetProgressView() {
  document.getElementById('done-section').classList.add('hidden');
  document.getElementById('done-card').className = 'bg-gray-900 rounded-xl border p-6 text-center';
  document.getElementById('done-title').className = 'text-xl font-bold mb-2';
  document.getElementById('log').replaceChildren();
}

function showFormError(message) {
  const form = document.getElementById('setup-form');
  let err = document.getElementById('form-error');
  if (!err) {
    err = document.createElement('div');
    err.id = 'form-error';
    err.className = 'text-red-400 text-sm mt-2';
    form.querySelector('.space-y-4').appendChild(err);
  }
  err.textContent = message;
}

function clearFormError() {
  const err = document.getElementById('form-error');
  if (err) {
    err.textContent = '';
  }
}

function renderPhases() {
  const container = document.getElementById('phases');
  container.replaceChildren();
  for (const phase of PHASE_ORDER) {
    const row = document.createElement('div');
    row.id = 'phase-' + phase;
    row.className = 'flex items-center gap-3 p-3 rounded-lg bg-gray-800/50 border border-gray-800';

    const iconDiv = document.createElement('div');
    iconDiv.id = 'phase-icon-' + phase;
    iconDiv.className = 'w-6 h-6 flex items-center justify-center text-gray-600';
    iconDiv.innerHTML = ICONS.pending;

    const content = document.createElement('div');
    content.className = 'flex-1';

    const label = document.createElement('div');
    label.className = 'text-sm font-medium text-gray-300';
    label.textContent = PHASE_LABELS[phase];

    const msg = document.createElement('div');
    msg.id = 'phase-msg-' + phase;
    msg.className = 'text-xs text-gray-500 mt-0.5';

    content.appendChild(label);
    content.appendChild(msg);
    row.appendChild(iconDiv);
    row.appendChild(content);
    container.appendChild(row);
  }
}

function connectSSE() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource('/api/events');

  eventSource.addEventListener('phase', (e) => {
    const data = JSON.parse(e.data);
    updatePhase(data.phase, data.status, data.message);
  });

  eventSource.addEventListener('log', (e) => {
    const data = JSON.parse(e.data);
    addLog(data.message);
  });

  eventSource.addEventListener('error', (e) => {
    const data = JSON.parse(e.data);
    addLog('[ERROR] ' + data.phase + ': ' + data.message);
    document.getElementById('action-buttons').classList.remove('hidden');
  });

  eventSource.addEventListener('done', (e) => {
    const data = JSON.parse(e.data);
    showDone(data.success, data.message);
  });
}

function updatePhase(phase, status, message) {
  const el = document.getElementById('phase-' + phase);
  const icon = document.getElementById('phase-icon-' + phase);
  const msg = document.getElementById('phase-msg-' + phase);

  if (!el) return;

  msg.textContent = message || '';
  el.className = 'flex items-center gap-3 p-3 rounded-lg border';

  switch (status) {
    case 'running':
    case 'waiting':
      el.classList.add('bg-blue-900/20', 'border-blue-800');
      icon.innerHTML = ICONS.spinner;
      break;
    case 'done':
      el.classList.add('bg-green-900/20', 'border-green-800');
      icon.innerHTML = ICONS.check;
      break;
    case 'skipped':
      el.classList.add('bg-gray-800/50', 'border-gray-700');
      icon.innerHTML = ICONS.skip;
      break;
    case 'error':
      el.classList.add('bg-red-900/20', 'border-red-800');
      icon.innerHTML = ICONS.error;
      break;
    default:
      el.classList.add('bg-gray-800/50', 'border-gray-800');
  }
}

function addLog(message) {
  const log = document.getElementById('log');
  const time = new Date().toLocaleTimeString('zh-CN');
  const line = document.createElement('div');
  line.textContent = '[' + time + '] ' + message;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

function showDone(success, message) {
  if (success) {
    document.getElementById('action-buttons').classList.add('hidden');
  } else {
    document.getElementById('action-buttons').classList.remove('hidden');
  }

  document.getElementById('done-section').classList.remove('hidden');

  const card = document.getElementById('done-card');
  const icon = document.getElementById('done-icon');
  const title = document.getElementById('done-title');
  const msg = document.getElementById('done-message');

  card.className = 'bg-gray-900 rounded-xl border p-6 text-center';
  title.className = 'text-xl font-bold mb-2';

  if (success) {
    card.classList.add('border-green-800');
    icon.textContent = '\u2705';
    title.textContent = '\u6267\u884C\u5B8C\u6210';
    title.classList.add('text-green-400');
  } else {
    card.classList.add('border-red-800');
    icon.textContent = '\u274C';
    title.textContent = '\u6267\u884C\u5931\u8D25';
    title.classList.add('text-red-400');
  }
  msg.textContent = message;

  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }

  checkState().catch(() => {});
}

async function retryPhase() {
  try {
    const res = await fetch('/api/retry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || '重试失败');
    }
    addLog('正在重试...');
  } catch (err) {
    addLog('重试失败: ' + err.message);
  }
}

async function cancelInstall() {
  try {
    await fetch('/api/cancel', { method: 'POST' });
    addLog('\u5DF2\u53D6\u6D88');
    document.getElementById('action-buttons').classList.add('hidden');
  } catch (err) {
    addLog('\u53D6\u6D88\u5931\u8D25: ' + err.message);
  }
}

async function resetSavedState() {
  try {
    const res = await fetch('/api/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clearLogin: false }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || '清空状态失败');
    }

    pendingState = null;
    document.getElementById('resume-banner').classList.add('hidden');
    document.getElementById('start-phase').value = '';
    document.getElementById('end-phase').value = '';
    addLog('已清空断点状态');
  } catch (err) {
    showFormError('清空状态失败: ' + err.message);
  }
}

async function clearLoginData() {
  try {
    const res = await fetch('/api/reset-login', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || '清空登录信息失败');
    }

    document.getElementById('clear-login').checked = true;
    addLog('已清空飞书登录信息，下次启动将重新扫码');
  } catch (err) {
    showFormError('清空登录信息失败: ' + err.message);
  }
}
