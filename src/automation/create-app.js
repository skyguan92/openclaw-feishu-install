const S = require('./selectors');

async function createApp(page, bus, { appName, appDescription }) {
  const safeAppName = normalizeText(appName, 32);
  const safeAppDescription = normalizeText(appDescription, 120);

  bus.sendPhase('create_app', 'running', '正在创建飞书应用...');

  await page.goto(S.urls.appList, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  // Click "创建企业自建应用"
  bus.sendLog('点击"创建企业自建应用"...');
  const createBtn = page.getByText(S.createApp.createButton);
  await createBtn.waitFor({ timeout: 15000 });
  await createBtn.click();
  await page.waitForTimeout(2000);

  const modal = page.locator('.ud__dialog__content.ud__modal').filter({ hasText: '创建企业自建应用' }).last();
  await modal.waitFor({ timeout: 10000 });

  if (safeAppName !== appName) {
    bus.sendLog(`应用名称超过 32 字符，已截断为: ${safeAppName}`);
  } else {
    bus.sendLog(`填入应用名称: ${safeAppName}`);
  }
  const nameInputs = modal.locator('input[type="text"], input:not([type])');
  const count = await nameInputs.count();
  let nameInput = null;
  for (let i = 0; i < count; i += 1) {
    const candidate = nameInputs.nth(i);
    if (await candidate.isVisible().catch(() => false)) {
      nameInput = candidate;
      break;
    }
  }
  if (!nameInput) {
    throw new Error('无法找到应用名称输入框');
  }
  await nameInput.click();
  await nameInput.fill(safeAppName);
  const afterVal = await nameInput.inputValue().catch(() => '');
  if (afterVal !== safeAppName) {
    throw new Error('应用名称输入失败');
  }
  bus.sendLog('成功填入应用名称');

  // Fill description — first visible textarea
  if (safeAppDescription !== appDescription) {
    bus.sendLog('应用描述超过 120 字符，已自动截断');
  } else {
    bus.sendLog(`填入应用描述: ${safeAppDescription}`);
  }
  const descInput = modal.locator('textarea').first();
  await descInput.waitFor({ timeout: 5000 });
  await descInput.fill(safeAppDescription);

  // Click "创建"
  bus.sendLog('点击"创建"...');
  await modal.getByRole('button', { name: S.createApp.confirmButton, exact: true }).click();

  // Wait for navigation to app detail page
  bus.sendLog('等待应用创建完成...');
  await page.waitForURL(/\/app\/cli_[a-zA-Z0-9]+/, { timeout: 30000 });

  const url = page.url();
  const match = url.match(S.createApp.appIdFromUrl);
  if (!match) {
    throw new Error('无法从 URL 中提取 App ID');
  }

  const appId = match[1];
  bus.sendPhase('create_app', 'done', `应用创建成功: ${appId}`);
  bus.sendLog(`App ID: ${appId}`);
  return appId;
}

function normalizeText(value, maxLength) {
  const text = String(value || '').trim();
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength);
}

module.exports = { createApp };
