const S = require('./selectors');
const { dismissModals } = require('./dismiss-modals');
const fs = require('fs');
const path = require('path');
const { LOG_DIR } = require('../utils/paths');
const {
  buildFeishuUrl,
  isFeishuDeveloperApiUrl,
  simplifyFeishuUrl,
} = require('../config/feishu-domain');

const PUBLISH_COMMIT_RESPONSE_TIMEOUT_MS = 20000;
const PUBLISH_RESULT_TIMEOUT_MS = 180000;
const PUBLISH_POLL_INTERVAL_MS = 3000;
const PUBLISH_REFRESH_INTERVAL_MS = 15000;
const TRACE_EVENT_LIMIT = 20;
const AVAILABLE_RANGE_MANUAL_ACTION_MESSAGE = '若需让其他成员在 Feishu / Lark 中搜到机器人，仍需到“版本管理与发布 → 可用范围”手动添加人员或部门并重新发布。';

async function publishApp(page, bus, appId, options = {}) {
  const trace = observePublishResponses(page, bus);
  const forceNewVersion = options.forceNewVersion === true;
  let lastObservedState = null;

  try {
    bus.sendPhase('publish', 'running', '正在发布应用...');

    await page.goto(S.urls.credentials(appId), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);
    await dismissModals(page, bus);
    await page.waitForTimeout(1000);

    bus.sendLog('点击侧边栏"版本管理与发布"...');
    const versionLink = page.locator(`text=${S.sidebar.version}`).first();
    try {
      await versionLink.waitFor({ timeout: 10000 });
      await versionLink.click();
      await page.waitForTimeout(3000);
    } catch {
      bus.sendLog('侧边栏点击失败，尝试直接导航...');
      await page.goto(S.urls.version(appId), { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(3000);
    }

    bus.sendLog(`版本页 URL: ${page.url()}`);

    lastObservedState = await inspectPublishState(page, appId);
    bus.sendLog(`版本页状态: ${formatPublishStateSummary(lastObservedState)}`);
    if (lastObservedState.published && !forceNewVersion) {
      const outcome = buildPublishOutcome('already_published');
      bus.sendLog('检测到当前修改均已发布，跳过创建新版本');
      bus.sendLog(outcome.manualActionMessage);
      bus.sendPhase('publish', 'done', outcome.phaseDoneMessage);
      return outcome;
    }

    if (lastObservedState.published && forceNewVersion) {
      bus.sendLog('检测到当前版本已发布，但测试脚本启用了强制新建版本，将继续创建新版本验证发布流程');
    }

    await ensureDraftVersion(page, bus, trace, appId);
    lastObservedState = await inspectPublishState(page, appId);
    let versionNumber = lastObservedState.latestVersion?.appVersion || buildVersionNumber();

    if (lastObservedState.hasSubmitAction && !lastObservedState.hasSaveAction) {
      bus.sendLog(`检测到已保存的版本草稿 ${versionNumber}，直接进入提交发布`);
    } else {
      versionNumber = await fillVersionForm(page, bus);
      lastObservedState = await saveDraft(page, bus, appId, versionNumber);
      lastObservedState = await waitForPostSaveState(page, bus, appId, versionNumber, lastObservedState);

      if (lastObservedState.validationHints.length) {
        throw new Error(`保存版本后页面提示仍有必填项未处理: ${lastObservedState.validationHints.join(' / ')}`);
      }
    }

    if (lastObservedState.published) {
      bus.sendLog('保存后检测到应用已发布（免审核模式），跳过确认发布');
    } else {
      await confirmPublish(page, bus, trace);

      const publishResult = await waitForPublishResult(page, bus, appId, trace);
      lastObservedState = publishResult.state;
      if (publishResult.status !== 'published') {
        throw new Error(publishResult.message || '版本提交后未进入已发布状态');
      }
    }

    const outcome = buildPublishOutcome('published', { versionNumber });
    bus.sendLog(outcome.manualActionMessage);
    bus.sendPhase('publish', 'done', outcome.phaseDoneMessage);
    return outcome;
  } catch (err) {
    await capturePublishDebug(page, bus, trace, lastObservedState);
    throw err;
  } finally {
    trace.dispose();
  }
}

function buildPublishOutcome(status, options = {}) {
  const versionNumber = String(options.versionNumber || '').trim();
  const primaryMessage = status === 'already_published'
    ? '已有发布版本，跳过'
    : `应用已发布上线（版本 ${versionNumber || 'unknown'}）`;

  return {
    status,
    primaryMessage,
    manualActionRequired: true,
    manualActionMessage: AVAILABLE_RANGE_MANUAL_ACTION_MESSAGE,
    phaseDoneMessage: `${primaryMessage}；${AVAILABLE_RANGE_MANUAL_ACTION_MESSAGE}`,
  };
}

function observePublishResponses(page, bus) {
  const state = {
    lastCreatedVersionId: null,
    lastCommitEnvelope: null,
    lastRequestFailure: null,
    recentEvents: [],
  };

  const pushEvent = (type, url, payload) => {
    state.recentEvents.push({
      at: new Date().toISOString(),
      type,
      url: simplifyFeishuUrl(url),
      payload: compactValue(payload, 1200),
    });
    if (state.recentEvents.length > TRACE_EVENT_LIMIT) {
      state.recentEvents.shift();
    }
  };

  const onResponse = async (response) => {
    const url = response.url();
    if (!isFeishuDeveloperApiUrl(url)) {
      return;
    }

    try {
      const data = await response.json().catch(() => null);
      if (url.includes('/publish/') || url.includes('/app_version/')) {
        pushEvent('response', url, {
          status: response.status(),
          ok: response.ok(),
          body: data,
        });
      }

      if (url.includes('/app_version/create/')) {
        state.lastCreatedVersionId = data?.data?.versionId || state.lastCreatedVersionId;
        if (state.lastCreatedVersionId) {
          bus.sendLog(`飞书返回新版本草稿 versionId=${state.lastCreatedVersionId}`);
        }
      }

      if (url.includes('/publish/commit/')) {
        state.lastCommitEnvelope = {
          at: new Date().toISOString(),
          status: response.status(),
          ok: response.ok(),
          body: data,
        };
        bus.sendLog(`飞书发布提交响应(${response.status()}): ${compactValue(data || {}, 500)}`);
      }
    } catch {
      // ignore non-json responses
    }
  };

  const onRequestFailed = (request) => {
    const url = request.url();
    if (!url.includes('/publish/') && !url.includes('/app_version/')) {
      return;
    }

    state.lastRequestFailure = {
      at: new Date().toISOString(),
      url: simplifyFeishuUrl(url),
      errorText: request.failure()?.errorText || 'unknown',
    };
    pushEvent('requestfailed', url, state.lastRequestFailure);
    bus.sendLog(`飞书发布相关请求失败: ${state.lastRequestFailure.url} (${state.lastRequestFailure.errorText})`);
  };

  page.on('response', onResponse);
  page.on('requestfailed', onRequestFailed);
  return {
    get lastCreatedVersionId() {
      return state.lastCreatedVersionId;
    },
    get lastCommitEnvelope() {
      return state.lastCommitEnvelope;
    },
    get lastRequestFailure() {
      return state.lastRequestFailure;
    },
    get recentEvents() {
      return state.recentEvents.slice();
    },
    snapshot() {
      return {
        lastCreatedVersionId: state.lastCreatedVersionId,
        lastCommitEnvelope: state.lastCommitEnvelope,
        lastRequestFailure: state.lastRequestFailure,
        recentEvents: state.recentEvents.slice(),
      };
    },
    dispose() {
      page.off('response', onResponse);
      page.off('requestfailed', onRequestFailed);
    },
  };
}

async function ensureDraftVersion(page, bus, trace, appId) {
  if (await isDraftVersionPage(page)) {
    return;
  }

  const currentState = await inspectPublishState(page, appId);
  if (currentState.latestVersionStatus != null && currentState.latestVersionStatus !== 2) {
    bus.sendLog(`检测到现有未发布版本 ${currentState.latestVersion?.appVersion || ''}，尝试进入版本详情继续发布`);
    const openDetail = await clickFirstVisibleButton(page, ['查看版本详情', '编辑']);
    if (openDetail) {
      await page.waitForTimeout(4000);
      bus.sendLog(`进入版本详情后 URL: ${page.url()}`);
      const detailState = await inspectPublishState(page, appId);
      if ((await isDraftVersionPage(page)) || detailState.hasSubmitAction) {
        return;
      }
    }
  }

  bus.sendLog('点击"创建版本"...');
  const clicked = await clickFirstVisibleButton(page, ['创建版本', '新建版本']);
  if (!clicked) {
    const buttons = await getVisibleButtonLabels(page);
    throw new Error(`"创建版本"按钮未找到；当前可见按钮: ${buttons.join(' / ') || '无'}`);
  }

  await page.waitForTimeout(4000);
  bus.sendLog(`创建版本后 URL: ${page.url()}`);

  if (await isDraftVersionPage(page)) {
    return;
  }

  if (trace.lastCreatedVersionId) {
    bus.sendLog(`已捕获飞书创建版本接口，versionId=${trace.lastCreatedVersionId}；继续尝试当前页面发布`);
    return;
  }

  if (!(await isDraftVersionPage(page))) {
    throw new Error('创建版本后未进入版本详情表单页');
  }
}

async function fillVersionForm(page, bus) {
  let versionNumber = buildVersionNumber();
  let versionInput = await findVisibleInputByPlaceholder(page, [
    '对用户展示的正式版本号',
    '应用版本号',
  ]);

  if (!versionInput) {
    versionInput = await findGenericVisibleField(page, 'input');
    if (versionInput) {
      bus.sendLog('未匹配到明确的版本号 placeholder，回退到通用“请填写”输入框');
    }
  }

  if (versionInput) {
    const currentValue = await versionInput.inputValue().catch(() => '');
    if (currentValue) {
      versionNumber = currentValue;
      bus.sendLog(`沿用已有版本号 ${versionNumber}`);
    } else {
      await versionInput.fill(versionNumber);
      bus.sendLog(`已填入版本号 ${versionNumber}`);
    }
  } else {
    const bodyVersion = await extractVersionNumberFromBody(page);
    if (bodyVersion) {
      versionNumber = bodyVersion;
      bus.sendLog(`未定位到版本号输入框，沿用页面默认版本号 ${versionNumber}`);
    } else {
      bus.sendLog('未定位到版本号输入框，后续将依赖飞书页面默认值');
    }
  }

  let descInput = await findVisibleInputByPlaceholder(page, [
    '该内容将展示在应用的更新日志中',
    '此内容将于应用的更新日志中显示',
    '更新说明',
  ], 'textarea');

  if (!descInput) {
    descInput = await findGenericVisibleField(page, 'textarea');
    if (descInput) {
      bus.sendLog('未匹配到明确的更新说明 placeholder，回退到通用“请填写”文本框');
    }
  }

  if (descInput) {
    const currentDesc = await descInput.inputValue().catch(() => '');
    if (!currentDesc) {
      await descInput.fill('OpenClaw automated release');
      bus.sendLog('已填入更新说明');
    }
  } else {
    const filledRichText = await fillRichTextByPlaceholder(page, [
      '该内容将展示在应用的更新日志中',
      '请填写',
    ], 'OpenClaw automated release');
    if (filledRichText) {
      bus.sendLog('已填入更新说明（富文本编辑器）');
    } else {
      bus.sendLog('未定位到更新说明输入框，跳过自动填写');
    }
  }

  return versionNumber;
}

async function saveDraft(page, bus, appId, versionNumber) {
  let clicked = false;
  const formSave = page.locator('button:has-text("保存")').first();
  if (await formSave.isVisible().catch(() => false)) {
    try {
      await formSave.click({ force: true });
      clicked = true;
    } catch {
      // fallback
    }
  }

  if (!clicked) {
    clicked = await clickFirstVisibleButton(page, ['保存', '保存并继续']);
  }

  if (!clicked) {
    const buttons = await getVisibleButtonLabels(page);
    throw new Error(`保存按钮未找到；当前可见按钮: ${buttons.join(' / ') || '无'}`);
  }
  bus.sendLog('已保存版本草稿');

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const state = await inspectPublishState(page, appId);

    if (state.validationHints.length) {
      throw new Error(`保存版本后页面提示必填项未填写: ${state.validationHints.join(' / ')}`);
    }

    if (state.latestVersion && state.latestVersion.appVersion === versionNumber) {
      bus.sendLog(`已在飞书版本列表中看到版本 ${versionNumber}，状态=${state.latestVersionStatus ?? 'unknown'}`);
      return state;
    }

    await page.waitForTimeout(1500);
  }

  const state = await inspectPublishState(page, appId);
  throw new Error(`保存版本后未在飞书版本列表中看到版本 ${versionNumber}；最后状态: ${formatPublishStateSummary(state)}`);
}

async function confirmPublish(page, bus, trace) {
  const commitResponsePromise = waitForPublishCommitResponse(page, PUBLISH_COMMIT_RESPONSE_TIMEOUT_MS);

  let clicked = await clickFirstVisibleButton(page, ['确认发布', '提交发布', '申请线上发布', '发布']);
  if (!clicked) {
    bus.sendLog('未找到 button 角色的发布按钮，尝试点击文本匹配的可点击元素...');
    for (const label of ['申请线上发布', '提交发布', '确认发布', '申请发布']) {
      const textEl = page.getByText(label, { exact: true }).first();
      if (await textEl.isVisible().catch(() => false)) {
        try {
          await textEl.click({ force: true });
          bus.sendLog(`通过文本匹配点击了: ${label}`);
          clicked = true;
          break;
        } catch {
          // try next
        }
      }
    }
  }

  if (!clicked) {
    const buttons = await getVisibleButtonLabels(page);
    throw new Error(`发布按钮未找到；当前可见按钮: ${buttons.join(' / ') || '无'}`);
  }
  bus.sendLog('已点击发布确认按钮');

  const confirmed = await clickFirstVisibleButton(page, ['确定', '确认'], { exact: true });
  if (confirmed) {
    bus.sendLog('已确认发布提示弹窗');
  }

  const commitResponse = await commitResponsePromise;
  if (commitResponse) {
    bus.sendLog(`已观测到发布提交接口响应（HTTP ${commitResponse.status()}）`);
  } else {
    bus.sendLog(`未在 ${Math.round(PUBLISH_COMMIT_RESPONSE_TIMEOUT_MS / 1000)} 秒内观测到发布提交接口，继续根据页面状态确认结果`);
  }

  await page.waitForTimeout(2500);
  const commitFailure = getCommitFailureMessage(trace.lastCommitEnvelope);
  if (commitFailure) {
    throw new Error(commitFailure);
  }
}

async function waitForPublishResult(page, bus, appId, trace, timeoutMs = PUBLISH_RESULT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let nextRefreshAt = Date.now() + PUBLISH_REFRESH_INTERVAL_MS;
  let lastSummary = '';
  let lastState = null;

  while (Date.now() < deadline) {
    lastState = await inspectPublishState(page, appId);

    const commitFailure = getCommitFailureMessage(trace.lastCommitEnvelope);
    if (commitFailure) {
      throw new Error(commitFailure);
    }

    const summary = formatPublishStateSummary(lastState);
    if (summary !== lastSummary) {
      bus.sendLog(`等待发布结果: ${summary}`);
      lastSummary = summary;
    }

    if (lastState.published) {
      return {
        status: 'published',
        state: lastState,
      };
    }

    if (Date.now() >= nextRefreshAt) {
      bus.sendLog('发布状态仍未刷新，重新打开版本页确认...');
      await reloadVersionPage(page, bus, appId);
      nextRefreshAt = Date.now() + PUBLISH_REFRESH_INTERVAL_MS;
      continue;
    }

    await page.waitForTimeout(PUBLISH_POLL_INTERVAL_MS);
  }

  return {
    status: 'unknown',
    state: lastState,
    message: `等待发布完成超时（${Math.round(timeoutMs / 1000)} 秒）；最后状态: ${formatPublishStateSummary(lastState)}`,
  };
}

async function waitForPostSaveState(page, bus, appId, versionNumber, initialState = null, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let nextRefreshAt = Date.now() + 10000;
  let lastState = initialState;

  while (Date.now() < deadline) {
    lastState = lastState || await inspectPublishState(page, appId);

    if (lastState.validationHints.length || lastState.published || lastState.hasSubmitAction) {
      return lastState;
    }

    if (lastState.latestVersion && lastState.latestVersion.appVersion === versionNumber && Date.now() >= nextRefreshAt) {
      bus.sendLog('版本草稿已保存，重新打开版本页确认是否出现提交发布按钮...');
      await reloadVersionPage(page, bus, appId);
      nextRefreshAt = Date.now() + 10000;
    } else {
      await page.waitForTimeout(1500);
    }

    lastState = await inspectPublishState(page, appId);
  }

  return lastState || await inspectPublishState(page, appId);
}

async function isDraftVersionPage(page) {
  const bodyText = await page.textContent('body').catch(() => '');
  return bodyText.includes('应用版本号')
    && bodyText.includes('更新说明')
    && (
      bodyText.includes('保存')
      || bodyText.includes('待申请')
      || bodyText.includes('确认发布')
      || bodyText.includes('提交发布')
      || bodyText.includes('申请线上发布')
      || page.url().includes('/version/create')
    );
}

async function inspectPublishState(page, appId) {
  const [meta, versionList, bodyText, visibleButtons, validationHints] = await Promise.all([
    appId ? fetchFeishuJson(page, buildFeishuUrl(`/developers/v1/app/${appId}`)) : null,
    appId ? fetchVersionList(page, appId) : null,
    page.textContent('body').catch(() => ''),
    getVisibleButtonLabels(page).catch(() => []),
    getVisibleValidationHints(page).catch(() => []),
  ]);

  const versions = Array.isArray(versionList?.data?.versions) ? versionList.data.versions : [];
  const latestVersion = versions[0] || null;
  const latestVersionStatus = latestVersion?.versionStatus ?? null;
  const metaStatus = {
    appListStatus: meta?.data?.appListStatus ?? null,
    appStatus: meta?.data?.appStatus ?? null,
  };
  const metaPublished = metaStatus.appListStatus === 2 || metaStatus.appStatus === 1;
  const versionListPublished = latestVersionStatus === 2;
  const hasDraftForm = bodyText.includes('应用版本号') && bodyText.includes('更新说明');
  const hasSaveAction = containsAnyButton(visibleButtons, ['保存', '保存并继续']);
  const hasSubmitAction = containsAnyButton(visibleButtons, ['确认发布', '提交发布', '申请线上发布']);
  const hasCreateVersionAction = containsAnyButton(visibleButtons, ['创建版本', '新建版本']);
  const hasPendingText = bodyText.includes('待申请')
    || bodyText.includes('待发布')
    || bodyText.includes('草稿')
    || bodyText.includes('申请线上发布');
  const processing = bodyText.includes('发布中')
    || bodyText.includes('审核中')
    || bodyText.includes('处理中');
  const uiPublished = bodyText.includes('审核结果')
    && bodyText.includes('通过')
    && bodyText.includes('发布于');
  const hasUnpublishedLatestVersion = latestVersionStatus != null && latestVersionStatus !== 2;
  const pendingState = hasDraftForm || hasSaveAction || hasSubmitAction || hasPendingText || hasUnpublishedLatestVersion;
  const published = versionListPublished || uiPublished || (metaPublished && !pendingState && !latestVersion);

  return {
    url: page.url(),
    metaStatus,
    latestVersion,
    latestVersionStatus,
    visibleButtons,
    validationHints,
    uiPublished,
    metaPublished,
    versionListPublished,
    hasDraftForm,
    hasSaveAction,
    hasSubmitAction,
    hasCreateVersionAction,
    pendingState,
    processing,
    published,
  };
}

async function fetchFeishuJson(page, url) {
  try {
    const result = await page.evaluate(async (targetUrl) => {
      const response = await fetch(targetUrl, {
        method: 'GET',
        credentials: 'include',
        headers: {
          Accept: 'application/json, text/plain, */*',
        },
      });

      return {
        ok: response.ok,
        status: response.status,
        data: await response.json().catch(() => null),
      };
    }, url);

    return result.ok ? result.data : null;
  } catch {
    return null;
  }
}

async function fetchVersionList(page, appId) {
  try {
    const versionListUrl = buildFeishuUrl(`/developers/v1/app_version/list/${appId}`);
    const result = await page.evaluate(async (targetAppId) => {
      const response = await fetch(targetAppId, {
        method: 'GET',
        credentials: 'include',
        headers: {
          Accept: 'application/json, text/plain, */*',
          'x-csrf-token': window.csrfToken || '',
        },
      });

      return {
        ok: response.ok,
        status: response.status,
        data: await response.json().catch(() => null),
      };
    }, versionListUrl);

    return result.ok ? result.data : null;
  } catch {
    return null;
  }
}

async function waitForPublishCommitResponse(page, timeoutMs) {
  try {
    return await page.waitForResponse(
      (response) => response.url().includes('/publish/commit/'),
      { timeout: timeoutMs }
    );
  } catch {
    return null;
  }
}

async function reloadVersionPage(page, bus, appId) {
  await page.goto(S.urls.version(appId), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);
  await dismissModals(page, bus);
  await page.waitForTimeout(1000);
  bus.sendLog(`版本页 URL: ${page.url()}`);
}

async function findVisibleInputByPlaceholder(page, placeholders, selector = 'input') {
  for (const placeholder of placeholders) {
    const locator = page.locator(`${selector}[placeholder*="${placeholder}"]:visible`).first();
    if (await locator.isVisible().catch(() => false)) {
      return locator;
    }
  }

  return null;
}

async function findGenericVisibleField(page, selector = 'input') {
  for (const query of [
    `${selector}[placeholder*="请填写"]:visible`,
    `${selector}[aria-label*="请填写"]:visible`,
  ]) {
    const locator = page.locator(query).first();
    if (await locator.isVisible().catch(() => false)) {
      return locator;
    }
  }

  return null;
}

async function extractVersionNumberFromBody(page) {
  const bodyText = await page.textContent('body').catch(() => '');
  const match = bodyText.match(/\b\d+\.\d+\.\d{6,}\b/);
  return match ? match[0] : null;
}

async function fillRichTextByPlaceholder(page, placeholderHints, value) {
  for (const hint of placeholderHints) {
    const placeholder = page.getByText(hint, { exact: false }).first();
    if (!(await placeholder.isVisible().catch(() => false))) {
      continue;
    }

    try {
      await placeholder.click({ force: true });
      await page.keyboard.insertText(value);
      await page.waitForTimeout(300);
      const bodyText = await page.textContent('body').catch(() => '');
      if (bodyText.includes(value)) {
        return true;
      }
    } catch {
      // try next placeholder
    }
  }

  return false;
}

async function clickFirstVisibleButton(page, labels, options = {}) {
  const exact = options.exact !== false;

  for (const label of labels) {
    const locator = page.getByRole('button', { name: label, exact });
    const count = await locator.count();
    for (let index = count - 1; index >= 0; index -= 1) {
      const button = locator.nth(index);
      if (!(await button.isVisible().catch(() => false))) {
        continue;
      }

      try {
        await button.click({ force: true });
        return true;
      } catch {
        // keep trying other candidates
      }
    }
  }

  return false;
}

async function getVisibleButtonLabels(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('button'))
    .map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 20));
}

async function getVisibleValidationHints(page) {
  return page.evaluate(() => {
    const hints = [];
    const seen = new Set();

    for (const el of Array.from(document.querySelectorAll('body *'))) {
      if (!el || !el.innerText || !el.getClientRects().length) {
        continue;
      }

      const text = el.innerText.replace(/\s+/g, ' ').trim();
      if (!text || text.length > 20) {
        continue;
      }

      if (text === '请填写' || text.includes('必填') || text.includes('不能为空')) {
        if (!seen.has(text)) {
          seen.add(text);
          hints.push(text);
        }
      }
    }

    return hints.slice(0, 10);
  });
}

async function capturePublishDebug(page, bus, trace, lastObservedState) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const stamp = Date.now();
    const screenshotPath = path.join(LOG_DIR, `publish-debug-${stamp}.png`);
    const bodyPath = path.join(LOG_DIR, `publish-debug-${stamp}.txt`);
    const tracePath = path.join(LOG_DIR, `publish-debug-${stamp}.json`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    const bodyText = await page.textContent('body').catch(() => '');
    fs.writeFileSync(bodyPath, bodyText || '');
    const buttons = await getVisibleButtonLabels(page);
    fs.writeFileSync(tracePath, JSON.stringify({
      url: page.url(),
      buttons,
      lastObservedState,
      trace: trace && typeof trace.snapshot === 'function' ? trace.snapshot() : null,
    }, null, 2));
    bus.sendLog(`发布失败诊断已保存: ${screenshotPath}`);
    bus.sendLog(`发布失败状态快照已保存: ${tracePath}`);
    bus.sendLog(`发布页可见按钮: ${buttons.join(' / ') || '无'}`);
  } catch {
    // ignore diagnostic capture failure
  }
}

function containsAnyButton(buttons, labels) {
  return buttons.some((button) => labels.includes(button));
}

function getCommitFailureMessage(commitEnvelope) {
  if (!commitEnvelope) {
    return null;
  }

  if (commitEnvelope.status >= 400) {
    return `飞书发布提交接口返回 HTTP ${commitEnvelope.status}`;
  }

  const body = commitEnvelope.body;
  if (!body || typeof body !== 'object') {
    return null;
  }

  if (body.code != null && body.code !== 0) {
    return `飞书发布提交失败: code=${body.code}, msg=${body.msg || body.message || compactValue(body, 300)}`;
  }

  const result = body.data && typeof body.data === 'object' ? body.data : body;
  if (result && result.isOk === false) {
    return `飞书发布提交失败: ${compactValue(result, 300)}`;
  }

  return null;
}

function formatPublishStateSummary(state) {
  if (!state) {
    return '状态未知';
  }

  const flags = [];
  if (state.published) {
    flags.push('已发布');
  }
  if (state.pendingState) {
    flags.push('存在待发布内容');
  }
  if (state.processing) {
    flags.push('页面显示处理中');
  }
  if (state.hasCreateVersionAction) {
    flags.push('可创建新版本');
  }
  if (state.latestVersion) {
    flags.push(`latest=${state.latestVersion.appVersion}:${state.latestVersionStatus}`);
  }
  if (state.validationHints.length) {
    flags.push(`校验提示=${state.validationHints.join('/')}`);
  }

  const metaText = `meta=${state.metaStatus.appListStatus ?? '-'} / ${state.metaStatus.appStatus ?? '-'}`;
  const buttonText = state.visibleButtons.length ? state.visibleButtons.join(' / ') : '无按钮';
  return `${flags.join('，') || '状态未明'}; ${metaText}; buttons=${buttonText}`;
}

function compactValue(value, limit = 400) {
  let text = '';
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }

  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function buildVersionNumber() {
  const now = new Date();
  const parts = [
    now.getUTCFullYear().toString().slice(-2),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
    String(now.getUTCHours()).padStart(2, '0'),
    String(now.getUTCMinutes()).padStart(2, '0'),
    String(now.getUTCSeconds()).padStart(2, '0'),
  ];
  return `1.0.${parts.join('')}`;
}

module.exports = { buildPublishOutcome, publishApp };
