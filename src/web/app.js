const CHANNELS = {
  feishu: {
    id: 'feishu',
    title: '飞书',
    subtitle: '只需填写名称并扫码登录，剩余步骤由 AI 自动完成',
    accentClass: 'text-blue-400',
    buttonClass: ['bg-blue-600', 'hover:bg-blue-500'],
    botNameRequired: true,
    supportsBrowserLogin: true,
    resumeClearLabel: '清空飞书登录',
    clearLoginText: '启动前强制清空浏览器 cookies，重新扫码登录飞书',
    clearLoginButton: '清空飞书登录信息',
    phases: [
      'login',
      'create_app',
      'credentials',
      'bot',
      'permissions',
      'configure_openclaw',
      'restart_gateway',
      'events',
      'publish',
      'post_publish_message',
    ],
    phaseLabels: {
      login: '登录飞书',
      create_app: '创建应用',
      credentials: '获取凭证',
      bot: '启用机器人',
      permissions: '配置权限',
      configure_openclaw: '配置 OpenClaw',
      restart_gateway: '重启 Gateway',
      events: '事件订阅',
      publish: '发布应用',
      post_publish_message: '发送首条消息',
    },
  },
  wecom: {
    id: 'wecom',
    title: '企业微信',
    subtitle: '只需填写名称并扫码登录，剩余步骤由 AI 自动完成',
    accentClass: 'text-emerald-400',
    buttonClass: ['bg-emerald-600', 'hover:bg-emerald-500'],
    botNameRequired: true,
    supportsBrowserLogin: true,
    resumeClearLabel: '清空企业微信登录',
    clearLoginText: '启动前清空企业微信管理后台登录态，强制重新扫码登录。',
    clearLoginButton: '清空企业微信登录信息',
    phases: [
      'login',
      'create_bot',
      'configure_openclaw',
      'restart_gateway',
    ],
    phaseLabels: {
      login: '登录企业微信',
      create_bot: '创建机器人',
      configure_openclaw: '配置企业微信',
      restart_gateway: '重启 Gateway',
    },
  },
};

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
  applyChannelUI(getCurrentChannel());
  bindDerivedNameBehavior();
  await checkPreflight();
  await checkState();
});

function getCurrentChannel() {
  const selected = document.getElementById('channel-select').value;
  return CHANNELS[selected] ? selected : 'feishu';
}

function getChannelConfig(channel = getCurrentChannel()) {
  return CHANNELS[channel] || CHANNELS.feishu;
}

function getPendingStateForCurrentChannel() {
  const channel = getCurrentChannel();
  return pendingState && pendingState.channel === channel ? pendingState : null;
}

async function checkPreflight() {
  try {
    const res = await fetch('/api/preflight');
    const data = await res.json();
    renderPreflightAlerts(data);
  } catch {
    // preflight failed, continue anyway
  }
}

function renderPreflightAlerts(data = {}) {
  const alerts = document.getElementById('preflight-alerts');
  const errors = Array.isArray(data.errors) ? data.errors : [];
  const warnings = Array.isArray(data.warnings) ? data.warnings : [];

  alerts.replaceChildren();
  if (!errors.length && !warnings.length) {
    alerts.classList.add('hidden');
    return;
  }

  alerts.classList.remove('hidden');

  for (const warningMsg of warnings) {
    const div = document.createElement('div');
    div.className = 'bg-yellow-900/30 border border-yellow-800 rounded-lg p-3 mb-2 text-yellow-200 text-sm';
    div.textContent = warningMsg;
    alerts.appendChild(div);
  }

  for (const errMsg of errors) {
    const div = document.createElement('div');
    div.className = 'bg-red-900/30 border border-red-800 rounded-lg p-3 mb-2 text-red-300 text-sm';
    div.textContent = errMsg;
    alerts.appendChild(div);
  }
}

async function checkState() {
  try {
    const res = await fetch('/api/state');
    const state = await res.json();

    pendingState = state && state.channel ? state : null;
    if (pendingState && CHANNELS[pendingState.channel]) {
      document.getElementById('channel-select').value = pendingState.channel;
      applyChannelUI(pendingState.channel);
    }

    applyStateToForm(state || {});
    refreshResumeBanner();
  } catch {
    pendingState = null;
    refreshResumeBanner();
  }
}

function refreshResumeBanner() {
  const state = getPendingStateForCurrentChannel();
  const banner = document.getElementById('resume-banner');

  if (state && state.completedPhases && state.completedPhases.length > 0) {
    const detail = document.getElementById('resume-detail');
    const channelConfig = getChannelConfig(state.channel);
    const completed = state.completedPhases
      .map((phase) => channelConfig.phaseLabels[phase] || phase)
      .join(', ');
    const current = state.currentPhase ? `；当前停在: ${channelConfig.phaseLabels[state.currentPhase] || state.currentPhase}` : '';
    detail.textContent = `${channelConfig.title} 已完成: ${completed}${current}`;
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
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
  if (state.skipPairingApproval !== undefined) {
    document.getElementById('skip-pairing-approval').checked = Boolean(state.skipPairingApproval);
  }
  if (state.appId) {
    document.getElementById('existing-app-id').value = state.appId;
  }
  if (state.botId) {
    document.getElementById('wecom-bot-id').value = state.botId;
  }
  if (state.botSecret) {
    document.getElementById('wecom-bot-secret').value = state.botSecret;
  }
  if (state.websocketUrl) {
    document.getElementById('wecom-websocket-url').value = state.websocketUrl;
  }

  syncDerivedBotName();
}

function handleChannelChange() {
  applyChannelUI(getCurrentChannel());
  refreshResumeBanner();
  clearFormError();
  syncDerivedBotName();
}

function applyChannelUI(channel) {
  const config = getChannelConfig(channel);
  const accent = document.getElementById('title-accent');
  accent.textContent = config.title;
  accent.className = config.accentClass;
  document.getElementById('page-subtitle').textContent = config.subtitle;

  document.getElementById('feishu-fields').classList.toggle('hidden', channel !== 'feishu');
  document.getElementById('wecom-fields').classList.toggle('hidden', channel !== 'wecom');
  document.getElementById('advanced-feishu-fields').classList.toggle('hidden', channel !== 'feishu');
  document.getElementById('advanced-wecom-fields').classList.toggle('hidden', channel !== 'wecom');
  document.getElementById('feishu-recovery-fields').classList.toggle('hidden', channel !== 'feishu');
  document.getElementById('clear-login-row').classList.toggle('hidden', !config.supportsBrowserLogin);
  document.getElementById('bot-name-row').classList.toggle('hidden', channel === 'feishu');

  const botLabel = document.getElementById('bot-name-label');
  const botRequired = document.getElementById('bot-name-required');
  botLabel.childNodes[0].textContent = channel === 'wecom' ? 'OpenClaw 名称 ' : '机器人名称 ';
  botRequired.classList.toggle('hidden', !config.botNameRequired);

  document.getElementById('resume-clear-login-btn').textContent = config.resumeClearLabel;
  document.getElementById('clear-login-text').textContent = config.clearLoginText;

  const clearLoginBtn = document.getElementById('clear-login-btn');
  clearLoginBtn.textContent = config.clearLoginButton;
  clearLoginBtn.disabled = !config.supportsBrowserLogin;
  clearLoginBtn.classList.toggle('opacity-50', !config.supportsBrowserLogin);
  clearLoginBtn.classList.toggle('cursor-not-allowed', !config.supportsBrowserLogin);

  const startBtn = document.getElementById('start-btn');
  startBtn.className = 'w-full py-3 text-white font-semibold rounded-lg transition-colors';
  for (const cls of config.buttonClass) {
    startBtn.classList.add(cls);
  }
  startBtn.textContent = channel === 'wecom' ? '开始接入企业微信' : '开始自动安装';

  if (!config.supportsBrowserLogin) {
    document.getElementById('clear-login').checked = false;
  }

  renderPhaseSelects(channel);
}

function bindDerivedNameBehavior() {
  const appNameInput = document.getElementById('app-name');
  const botNameInput = document.getElementById('bot-name');

  appNameInput.addEventListener('input', () => {
    if (!botNameInput.dataset.touched || !botNameInput.value.trim()) {
      botNameInput.value = appNameInput.value;
    }
  });

  botNameInput.addEventListener('input', () => {
    botNameInput.dataset.touched = 'true';
  });

  syncDerivedBotName();
}

function syncDerivedBotName() {
  const appNameInput = document.getElementById('app-name');
  const botNameInput = document.getElementById('bot-name');
  if (!botNameInput.value.trim()) {
    botNameInput.value = appNameInput.value;
  }
}

function renderPhaseSelects(channel = getCurrentChannel()) {
  const config = getChannelConfig(channel);
  const startSelect = document.getElementById('start-phase');
  const endSelect = document.getElementById('end-phase');
  const startValue = startSelect.value;
  const endValue = endSelect.value;

  startSelect.replaceChildren();
  endSelect.replaceChildren();

  const defaultStart = document.createElement('option');
  defaultStart.value = '';
  defaultStart.textContent = '自动续跑 / 从断点继续';
  startSelect.appendChild(defaultStart);

  const defaultEnd = document.createElement('option');
  defaultEnd.value = '';
  defaultEnd.textContent = '直到执行完成';
  endSelect.appendChild(defaultEnd);

  for (const phase of config.phases) {
    const startOption = document.createElement('option');
    startOption.value = phase;
    startOption.textContent = config.phaseLabels[phase];
    startSelect.appendChild(startOption);

    const endOption = document.createElement('option');
    endOption.value = phase;
    endOption.textContent = `执行到 ${config.phaseLabels[phase]}`;
    endSelect.appendChild(endOption);
  }

  startSelect.value = config.phases.includes(startValue) ? startValue : '';
  endSelect.value = config.phases.includes(endValue) ? endValue : '';
}

function resumeInstall() {
  document.getElementById('resume-banner').classList.add('hidden');
  startInstall();
}

async function freshInstall() {
  await resetSavedState();
}

function collectPayload() {
  const channel = getCurrentChannel();
  const appName = document.getElementById('app-name').value.trim();
  const rawBotName = document.getElementById('bot-name').value.trim();
  const botName = rawBotName || appName;

  return {
    channel,
    appName,
    botName: channel === 'feishu' ? botName : rawBotName,
    appDescription: document.getElementById('app-desc').value.trim(),
    appId: document.getElementById('existing-app-id').value.trim(),
    appSecret: document.getElementById('existing-app-secret').value.trim(),
    botId: document.getElementById('wecom-bot-id').value.trim(),
    botSecret: document.getElementById('wecom-bot-secret').value.trim(),
    websocketUrl: document.getElementById('wecom-websocket-url').value.trim(),
    skipPairingApproval: document.getElementById('skip-pairing-approval').checked,
    startPhase: document.getElementById('start-phase').value,
    endPhase: document.getElementById('end-phase').value,
    clearLogin: document.getElementById('clear-login').checked,
  };
}

function startInstall() {
  clearFormError();
  const payload = collectPayload();
  const pending = getPendingStateForCurrentChannel();
  const config = getChannelConfig(payload.channel);
  const startIndex = payload.startPhase ? config.phases.indexOf(payload.startPhase) : -1;

  if (payload.channel === 'feishu') {
    const needsAppName = payload.startPhase === '' || startIndex <= config.phases.indexOf('create_app');

    if (needsAppName && !payload.appName && !(pending && pending.appName)) {
      showFormError('执行飞书安装前，需要先填写 OpenClaw 名称');
      return;
    }
  } else {
    const createBotIndex = config.phases.indexOf('create_bot');
    const configureIndex = config.phases.indexOf('configure_openclaw');
    const needsBotCreation = payload.startPhase === '' || startIndex <= createBotIndex;
    const needsBotCredentials = payload.startPhase !== '' && startIndex > createBotIndex && startIndex <= configureIndex;

    if (needsBotCreation && !payload.botName && !(pending && pending.botName)) {
      showFormError('执行企业微信接入前，需要先填写 OpenClaw 名称');
      return;
    }

    if (needsBotCredentials && !payload.botId && !(pending && pending.botId)) {
      showFormError('当前跳过了创建机器人步骤，但没有可复用的 Bot ID；请从 create_bot 开始，或恢复上次状态');
      return;
    }

    if (needsBotCredentials && !payload.botSecret && !(pending && pending.botSecret)) {
      showFormError('当前跳过了创建机器人步骤，但没有可复用的 Bot Secret；请从 create_bot 开始，或恢复上次状态');
      return;
    }
  }

  doStart(payload);
}

async function doStart(payload) {
  resetProgressView();
  document.getElementById('setup-form').classList.add('hidden');
  document.getElementById('progress-section').classList.remove('hidden');
  document.getElementById('action-buttons').classList.remove('hidden');

  renderPhases(payload.channel);
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

    addLog(`已启动 ${getChannelConfig(data.channel).title}，执行范围: ${data.startPhase} -> ${data.endPhase}`);
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

function renderPhases(channel = getCurrentChannel()) {
  const config = getChannelConfig(channel);
  const container = document.getElementById('phases');
  container.replaceChildren();
  for (const phase of config.phases) {
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
    label.textContent = config.phaseLabels[phase];

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
    title.textContent = '\u6267\u884c\u5b8c\u6210';
    title.classList.add('text-green-400');
  } else {
    card.classList.add('border-red-800');
    icon.textContent = '\u274c';
    title.textContent = '\u6267\u884c\u5931\u8d25';
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
    addLog('\u5df2\u53d6\u6d88');
    document.getElementById('action-buttons').classList.add('hidden');
  } catch (err) {
    addLog('\u53d6\u6d88\u5931\u8d25: ' + err.message);
  }
}

async function resetSavedState() {
  try {
    const res = await fetch('/api/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clearLogin: false, channel: getCurrentChannel() }),
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
  const config = getChannelConfig();
  if (!config.supportsBrowserLogin) {
    addLog('当前渠道无需清空浏览器登录信息');
    return;
  }

  try {
    const res = await fetch('/api/reset-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: getCurrentChannel() }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || '清空登录信息失败');
    }

    document.getElementById('clear-login').checked = true;
    addLog(`已清空${config.title}登录信息，下次启动将重新扫码`);
  } catch (err) {
    showFormError('清空登录信息失败: ' + err.message);
  }
}
