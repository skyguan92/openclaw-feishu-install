const S = require('./selectors');
const { dismissModals } = require('./dismiss-modals');
const fs = require('fs');
const path = require('path');
const { LOG_DIR } = require('../utils/paths');

async function configureEvents(page, bus, appId) {
  bus.sendPhase('events', 'running', '正在配置事件订阅...');

  await page.goto(S.urls.credentials(appId), { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);
  await dismissModals(page, bus);
  await page.waitForTimeout(1000);

  bus.sendLog('点击侧边栏"事件与回调"...');
  const eventsLink = page.locator(`text=${S.sidebar.events}`).first();
  const [newPage] = await Promise.all([
    page.context().waitForEvent('page', { timeout: 5000 }).catch(() => null),
    eventsLink.click(),
  ]);

  let workPage = page;
  if (newPage) {
    bus.sendLog('事件与回调在新标签页打开');
    await newPage.waitForLoadState('domcontentloaded');
    await newPage.waitForTimeout(3000);
    workPage = newPage;
  } else {
    await page.waitForTimeout(3000);
  }

  await dismissModals(workPage, bus);
  await workPage.waitForTimeout(1000);

  bus.sendLog(`事件页 URL: ${workPage.url()}`);
  fs.mkdirSync(LOG_DIR, { recursive: true });
  await safeScreenshot(workPage, 'events-page.png');

  const targetEvent = S.events.targetEvent;
  if (await hasConfiguredEvent(workPage, targetEvent)) {
    bus.sendLog(`事件 ${targetEvent} 已配置`);
  } else {
    await ensureLongConnectionMode(workPage, bus);
    await safeScreenshot(workPage, 'events-after-mode.png');
    await addTargetEvent(workPage, bus, targetEvent);
  }

  if (!(await hasConfiguredEvent(workPage, targetEvent))) {
    throw new Error(`事件 ${targetEvent} 未出现在页面上`);
  }

  bus.sendLog(`验证通过: ${targetEvent} 已出现在事件页面`);
  await safeScreenshot(workPage, 'events-done.png');

  if (newPage) {
    await newPage.close();
  }

  bus.sendPhase('events', 'done', '事件订阅配置完成');
}

async function ensureLongConnectionMode(page, bus) {
  if (await isLongConnectionConfigured(page)) {
    bus.sendLog('长连接模式已启用');
    return;
  }

  const editButton = page.locator('.switch-events-mode button.ud__button--icon-primary.ud__button--icon-size-sm').first();
  if (!(await editButton.isVisible().catch(() => false))) {
    throw new Error('事件订阅方式编辑按钮未找到');
  }

  await editButton.click({ force: true });
  await page.waitForTimeout(1500);

  const longConnText = page.getByText('使用 长连接 接收事件', { exact: false });
  if (await longConnText.isVisible().catch(() => false)) {
    await longConnText.click().catch(() => {});
  }

  const maxAttempts = 10;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const saveBtn = page.getByRole('button', { name: '保存', exact: true });
    if (!(await saveBtn.isVisible().catch(() => false))) {
      if (await isLongConnectionConfigured(page)) {
        bus.sendLog('长连接模式已启用');
        return;
      }

      await editButton.click({ force: true });
      await page.waitForTimeout(1000);
    }

    await saveBtn.click({ force: true });
    await page.waitForTimeout(2500);

    if (await isLongConnectionConfigured(page)) {
      bus.sendLog('已保存长连接模式');
      return;
    }

    const bodyText = await page.textContent('body');
    if (bodyText.includes('未检测到应用连接信息')) {
      bus.sendLog(`长连接尚未被飞书检测到，等待后重试 (${attempt}/${maxAttempts})`);
      await page.waitForTimeout(3000);
      continue;
    }
  }

  throw new Error('长连接模式保存失败，飞书仍未检测到应用连接信息');
}

async function addTargetEvent(page, bus, targetEvent) {
  if (await hasConfiguredEvent(page, targetEvent)) {
    return;
  }

  const addEventBtn = page.getByRole('button', { name: '添加事件', exact: true });
  await addEventBtn.waitFor({ timeout: 10000 });
  if (await addEventBtn.isDisabled()) {
    throw new Error('“添加事件”按钮仍处于禁用状态');
  }

  await addEventBtn.click();
  await page.waitForTimeout(2000);
  bus.sendLog('已打开"添加事件"弹窗');
  await safeScreenshot(page, 'events-add-dialog.png');

  const searchInput = page.getByPlaceholder('搜索').last();
  await searchInput.waitFor({ timeout: 10000 });
  await searchInput.fill(targetEvent);
  await page.waitForTimeout(2500);
  bus.sendLog(`已搜索: ${targetEvent}`);
  await safeScreenshot(page, 'events-search-results.png');

  const targetText = page.getByText(targetEvent, { exact: true }).first();
  await targetText.waitFor({ timeout: 10000 });

  const checkbox = page.locator('.event-dialog input[type="checkbox"]').first();
  if (!(await checkbox.isVisible().catch(() => false))) {
    throw new Error(`事件 ${targetEvent} 的选择框未找到`);
  }

  await checkbox.check().catch(async () => {
    await checkbox.click({ force: true });
  });
  await page.waitForTimeout(800);

  // 飞书 UI 曾用”确认添加”，后改为”添加”，按优先级依次尝试
  let confirmBtn = null;
  for (const label of ['添加', '确认添加']) {
    const btn = page.getByRole('button', { name: label, exact: true });
    if (await btn.waitFor({ state: 'visible', timeout: 2000 }).then(() => true).catch(() => false)) {
      confirmBtn = btn;
      bus.sendLog(`找到确认按钮: “${label}”`);
      break;
    }
  }
  if (!confirmBtn) {
    await safeScreenshot(page, 'error-events-confirm-btn.png');
    throw new Error('添加事件确认按钮未找到（尝试了”添加”和”确认添加”）');
  }
  if (await confirmBtn.isDisabled()) {
    throw new Error(`事件 ${targetEvent} 已勾选，但确认按钮仍不可用`);
  }

  await confirmBtn.click();
  await page.waitForTimeout(3000);

  if (!(await hasConfiguredEvent(page, targetEvent))) {
    throw new Error(`事件 ${targetEvent} 添加后未出现在页面上`);
  }

  bus.sendLog(`已添加事件 ${targetEvent}`);
}

async function hasConfiguredEvent(page, targetEvent) {
  const bodyText = await page.textContent('body');
  return bodyText.includes(targetEvent);
}

async function isLongConnectionConfigured(page) {
  const addEventBtn = page.getByRole('button', { name: '添加事件', exact: true });
  const bodyText = await page.textContent('body');
  const addButtonEnabled = await addEventBtn.isVisible().catch(() => false)
    && !(await addEventBtn.isDisabled().catch(() => true));
  const saveVisible = await page.getByRole('button', { name: '保存', exact: true }).isVisible().catch(() => false);

  return addButtonEnabled
    && bodyText.includes('订阅方式')
    && bodyText.includes('长连接')
    && !bodyText.includes('未配置')
    && !saveVisible;
}

async function safeScreenshot(page, fileName) {
  try {
    await page.screenshot({ path: path.join(LOG_DIR, fileName), fullPage: true });
  } catch {}
}

module.exports = { configureEvents };
