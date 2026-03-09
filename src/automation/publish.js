const S = require('./selectors');
const { dismissModals } = require('./dismiss-modals');
const fs = require('fs');
const path = require('path');
const { LOG_DIR } = require('../utils/paths');

async function publishApp(page, bus, appId) {
  const trace = observePublishResponses(page, bus);

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

    if (await isPublished(page, appId)) {
      bus.sendLog('检测到当前修改均已发布，跳过创建新版本');
      bus.sendLog('提醒：如果其他成员在飞书里搜不到机器人，还需要去“版本管理与发布 → 可用范围”里手动加人或部门并重新发布。');
      bus.sendPhase('publish', 'done', '已有发布版本，跳过');
      return 'already_published';
    }

    await ensureDraftVersion(page, bus, trace);
    const versionNumber = await fillVersionForm(page, bus);
    await saveDraft(page, bus);
    await confirmPublish(page, bus, trace);

    const publishStatus = await waitForPublishResult(page, appId, trace);
    if (publishStatus !== 'published') {
      throw new Error('版本提交后未进入已发布状态');
    }

    bus.sendLog('提醒：发布完成后若其他成员搜不到机器人，还需要到“版本管理与发布 → 可用范围”手动添加人员或部门并重新发布。');
    bus.sendPhase('publish', 'done', `应用已发布上线（版本 ${versionNumber}）`);
    return 'published';
  } catch (err) {
    await capturePublishDebug(page, bus);
    throw err;
  } finally {
    trace.dispose();
  }
}

function observePublishResponses(page, bus) {
  const state = {
    lastCreatedVersionId: null,
    lastCommitResult: null,
  };

  const onResponse = async (response) => {
    const url = response.url();
    if (!url.includes('open.feishu.cn/developers/v1/')) {
      return;
    }

    try {
      const data = await response.json();
      if (url.includes('/app_version/create/')) {
        state.lastCreatedVersionId = data?.data?.versionId || state.lastCreatedVersionId;
        if (state.lastCreatedVersionId) {
          bus.sendLog(`飞书返回新版本草稿 versionId=${state.lastCreatedVersionId}`);
        }
      }

      if (url.includes('/publish/commit/')) {
        state.lastCommitResult = data?.data || null;
        bus.sendLog(`飞书发布提交返回: ${JSON.stringify(state.lastCommitResult || {})}`);
      }
    } catch {
      // ignore non-json responses
    }
  };

  page.on('response', onResponse);
  return {
    ...state,
    get lastCreatedVersionId() {
      return state.lastCreatedVersionId;
    },
    get lastCommitResult() {
      return state.lastCommitResult;
    },
    dispose() {
      page.off('response', onResponse);
    },
  };
}

async function ensureDraftVersion(page, bus, trace) {
  if (await isDraftVersionPage(page)) {
    return;
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
  const versionInput = await findVisibleInputByPlaceholder(page, [
    '对用户展示的正式版本号',
    '应用版本号',
  ]);

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

  const descInput = await findVisibleInputByPlaceholder(page, [
    '此内容将于应用的更新日志中显示',
    '更新说明',
  ], 'textarea');
  if (descInput) {
    const currentDesc = await descInput.inputValue().catch(() => '');
    if (!currentDesc) {
      await descInput.fill('OpenClaw automated release');
      bus.sendLog('已填入更新说明');
    }
  } else {
    bus.sendLog('未定位到更新说明输入框，跳过自动填写');
  }

  return versionNumber;
}

async function saveDraft(page, bus) {
  const clicked = await clickFirstVisibleButton(page, ['保存', '保存并继续']);
  if (!clicked) {
    const buttons = await getVisibleButtonLabels(page);
    throw new Error(`保存按钮未找到；当前可见按钮: ${buttons.join(' / ') || '无'}`);
  }
  bus.sendLog('已保存版本草稿');
  await page.waitForTimeout(4000);

  const bodyText = await page.textContent('body');
  if (
    !bodyText.includes('待申请')
    && !bodyText.includes('确认发布')
    && !bodyText.includes('提交发布')
    && !bodyText.includes('发布')
  ) {
    throw new Error('保存版本后未进入待申请页面');
  }
}

async function confirmPublish(page, bus, trace) {
  const clicked = await clickFirstVisibleButton(page, ['确认发布', '提交发布', '发布']);
  if (!clicked) {
    const buttons = await getVisibleButtonLabels(page);
    throw new Error(`发布按钮未找到；当前可见按钮: ${buttons.join(' / ') || '无'}`);
  }
  bus.sendLog('已点击发布确认按钮');

  const confirmed = await clickFirstVisibleButton(page, ['确定', '确认'], { exact: true });
  if (confirmed) {
    bus.sendLog('已确认发布提示弹窗');
  }

  await page.waitForTimeout(2500);
  if (trace.lastCommitResult && trace.lastCommitResult.isOk === false) {
    throw new Error(`飞书发布提交失败: ${JSON.stringify(trace.lastCommitResult)}`);
  }
}

async function waitForPublishResult(page, appId, trace, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPublished(page, appId)) {
      return 'published';
    }

    if (trace.lastCommitResult && trace.lastCommitResult.isOk === false) {
      throw new Error(`飞书发布提交失败: ${JSON.stringify(trace.lastCommitResult)}`);
    }

    await page.waitForTimeout(2000);
  }
  return 'unknown';
}

async function isDraftVersionPage(page) {
  const bodyText = await page.textContent('body');
  return bodyText.includes('应用版本号')
    && bodyText.includes('更新说明')
    && (
      bodyText.includes('保存')
      || bodyText.includes('待申请')
      || bodyText.includes('确认发布')
      || bodyText.includes('提交发布')
      || page.url().includes('/version/create')
    );
}

async function isPublished(page, appId) {
  const meta = await fetchFeishuJson(page, `https://open.feishu.cn/developers/v1/app/${appId}`);
  if (meta?.data?.appListStatus === 2 || meta?.data?.appStatus === 1) {
    return true;
  }

  const bodyText = await page.textContent('body');
  return bodyText.includes('已发布')
    || bodyText.includes('当前修改均已发布')
    || (bodyText.includes('审核结果') && bodyText.includes('通过') && bodyText.includes('发布于'));
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

async function findVisibleInputByPlaceholder(page, placeholders, selector = 'input') {
  for (const placeholder of placeholders) {
    const locator = page.locator(`${selector}[placeholder*="${placeholder}"]:visible`).first();
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
    .map((el) => (el.innerText || '').trim())
    .filter(Boolean)
    .slice(0, 20));
}

async function capturePublishDebug(page, bus) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const stamp = Date.now();
    const screenshotPath = path.join(LOG_DIR, `publish-debug-${stamp}.png`);
    const bodyPath = path.join(LOG_DIR, `publish-debug-${stamp}.txt`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    const bodyText = await page.textContent('body').catch(() => '');
    fs.writeFileSync(bodyPath, bodyText || '');
    const buttons = await getVisibleButtonLabels(page);
    bus.sendLog(`发布失败诊断已保存: ${screenshotPath}`);
    bus.sendLog(`发布页可见按钮: ${buttons.join(' / ') || '无'}`);
  } catch {
    // ignore diagnostic capture failure
  }
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

module.exports = { publishApp };
