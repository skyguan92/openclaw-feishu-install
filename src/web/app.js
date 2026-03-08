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

// Initialize
window.addEventListener('DOMContentLoaded', async () => {
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
      // Use safe DOM methods instead of innerHTML
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

async function checkState() {
  try {
    const res = await fetch('/api/state');
    const state = await res.json();

    if (state && state.completedPhases && state.completedPhases.length > 0) {
      pendingState = state;
      const banner = document.getElementById('resume-banner');
      const detail = document.getElementById('resume-detail');
      banner.classList.remove('hidden');
      detail.textContent = '\u5DF2\u5B8C\u6210: ' + state.completedPhases.map(p => PHASE_LABELS[p] || p).join(', ');
    }
  } catch {
    // no state
  }
}

function resumeInstall() {
  document.getElementById('resume-banner').classList.add('hidden');
  const appName = document.getElementById('app-name').value || 'OpenClaw Bot';
  const botName = document.getElementById('bot-name').value || 'OpenClaw';
  doStart(appName, botName, document.getElementById('app-desc').value);
}

function freshInstall() {
  pendingState = null;
  document.getElementById('resume-banner').classList.add('hidden');
}

function startInstall() {
  const appName = document.getElementById('app-name').value.trim();
  const botName = document.getElementById('bot-name').value.trim();
  const appDesc = document.getElementById('app-desc').value.trim();

  if (!appName || !botName) {
    // Use a visible inline error instead of alert()
    const form = document.getElementById('setup-form');
    let err = document.getElementById('form-error');
    if (!err) {
      err = document.createElement('div');
      err.id = 'form-error';
      err.className = 'text-red-400 text-sm mt-2';
      form.querySelector('.space-y-4').appendChild(err);
    }
    err.textContent = '\u8BF7\u586B\u5199\u5E94\u7528\u540D\u79F0\u548C\u673A\u5668\u4EBA\u540D\u79F0';
    return;
  }

  doStart(appName, botName, appDesc);
}

async function doStart(appName, botName, appDescription) {
  document.getElementById('setup-form').classList.add('hidden');
  document.getElementById('progress-section').classList.remove('hidden');
  document.getElementById('action-buttons').classList.remove('hidden');

  renderPhases();
  connectSSE();

  try {
    await fetch('/api/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appName, botName, appDescription }),
    });
  } catch (err) {
    addLog('\u542F\u52A8\u5931\u8D25: ' + err.message);
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
    // Pending icon (safe hardcoded SVG)
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
  document.getElementById('action-buttons').classList.add('hidden');
  document.getElementById('done-section').classList.remove('hidden');

  const card = document.getElementById('done-card');
  const icon = document.getElementById('done-icon');
  const title = document.getElementById('done-title');
  const msg = document.getElementById('done-message');

  if (success) {
    card.classList.add('border-green-800');
    icon.textContent = '\u2705';
    title.textContent = '\u5B89\u88C5\u5B8C\u6210';
    title.classList.add('text-green-400');
  } else {
    card.classList.add('border-red-800');
    icon.textContent = '\u274C';
    title.textContent = '\u5B89\u88C5\u5931\u8D25';
    title.classList.add('text-red-400');
  }
  msg.textContent = message;

  if (eventSource) eventSource.close();
}

async function retryPhase() {
  try {
    await fetch('/api/retry', { method: 'POST' });
    addLog('\u6B63\u5728\u91CD\u8BD5...');
  } catch (err) {
    addLog('\u91CD\u8BD5\u5931\u8D25: ' + err.message);
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
