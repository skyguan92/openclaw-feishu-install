const S = require('./selectors');
const { dismissModals } = require('./dismiss-modals');

async function publishApp(page, bus, appId) {
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

  if (await isPublished(page)) {
    bus.sendLog('已有已发布版本');
    bus.sendPhase('publish', 'done', '已有发布版本，跳过');
    return 'already_published';
  }

  await ensureDraftVersion(page, bus);
  const versionNumber = await fillVersionForm(page, bus);
  await saveDraft(page, bus);
  await confirmPublish(page, bus);

  const publishStatus = await waitForPublishResult(page);
  if (publishStatus !== 'published') {
    throw new Error('版本提交后未进入已发布状态');
  }

  bus.sendPhase('publish', 'done', `应用已发布上线（版本 ${versionNumber}）`);
  return 'published';
}

async function ensureDraftVersion(page, bus) {
  if (await isDraftVersionPage(page)) {
    return;
  }

  bus.sendLog('点击"创建版本"...');
  const createButtons = page.getByRole('button', { name: '创建版本' });
  const count = await createButtons.count();
  bus.sendLog(`找到 ${count} 个"创建版本"按钮`);
  if (count === 0) {
    throw new Error('"创建版本"按钮未找到');
  }

  await createButtons.last().click();
  await page.waitForTimeout(4000);
  bus.sendLog(`创建版本后 URL: ${page.url()}`);

  if (!(await isDraftVersionPage(page))) {
    throw new Error('创建版本后未进入版本详情表单页');
  }
}

async function fillVersionForm(page, bus) {
  const versionInput = page.getByPlaceholder('对用户展示的正式版本号');
  await versionInput.waitFor({ timeout: 10000 });

  let versionNumber = await versionInput.inputValue().catch(() => '');
  if (!versionNumber) {
    versionNumber = buildVersionNumber();
    await versionInput.fill(versionNumber);
    bus.sendLog(`已填入版本号 ${versionNumber}`);
  } else {
    bus.sendLog(`沿用已有版本号 ${versionNumber}`);
  }

  const descInput = page.getByPlaceholder('此内容将于应用的更新日志中显示');
  await descInput.waitFor({ timeout: 10000 });
  const currentDesc = await descInput.inputValue().catch(() => '');
  if (!currentDesc) {
    await descInput.fill('OpenClaw automated release');
    bus.sendLog('已填入更新说明');
  }

  return versionNumber;
}

async function saveDraft(page, bus) {
  const saveBtn = page.getByRole('button', { name: '保存', exact: true });
  await saveBtn.waitFor({ timeout: 10000 });
  await saveBtn.click();
  bus.sendLog('已保存版本草稿');
  await page.waitForTimeout(4000);

  const bodyText = await page.textContent('body');
  if (!bodyText.includes('待申请') && !bodyText.includes('确认发布')) {
    throw new Error('保存版本后未进入待申请页面');
  }
}

async function confirmPublish(page, bus) {
  const confirmButton = page.getByRole('button', { name: '确认发布', exact: true }).last();
  await confirmButton.waitFor({ timeout: 10000 });
  await confirmButton.click({ force: true });
  bus.sendLog('已点击"确认发布"');

  const okButton = page.getByRole('button', { name: '确定', exact: true });
  if (await okButton.first().isVisible().catch(() => false)) {
    await okButton.first().click();
    bus.sendLog('已确认发布提示弹窗');
  }
}

async function waitForPublishResult(page, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPublished(page)) {
      return 'published';
    }
    await page.waitForTimeout(2000);
  }
  return 'unknown';
}

async function isDraftVersionPage(page) {
  const bodyText = await page.textContent('body');
  return bodyText.includes('应用版本号')
    && bodyText.includes('更新说明')
    && (bodyText.includes('保存') || bodyText.includes('待申请') || page.url().includes('/version/create'));
}

async function isPublished(page) {
  const bodyText = await page.textContent('body');
  return bodyText.includes('已发布')
    || bodyText.includes('当前修改均已发布')
    || (bodyText.includes('审核结果') && bodyText.includes('通过') && bodyText.includes('发布于'));
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
