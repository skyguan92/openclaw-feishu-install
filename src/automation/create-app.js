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

  // The modal has:
  //   - Multiple inputs on the page. The app name input is the one
  //     with empty placeholder inside the modal, at DOM index ~4.
  //   - A textarea for description (first visible textarea).
  //   - Buttons: "取消" and "创建"
  //
  // Strategy: find all visible empty inputs, the one inside the modal
  // (near "应用名称" text) is what we need.

  // Fill app name — find the input near "应用名称" label
  if (safeAppName !== appName) {
    bus.sendLog(`应用名称超过 32 字符，已截断为: ${safeAppName}`);
  } else {
    bus.sendLog(`填入应用名称: ${safeAppName}`);
  }
  // The modal's name input is the only visible input with empty value
  // that is NOT the search bars (which have placeholders)
  const allInputs = page.locator('input[type="text"], input:not([type])');
  const count = await allInputs.count();
  let nameInputFilled = false;
  for (let i = 0; i < count; i++) {
    const inp = allInputs.nth(i);
    if (!(await inp.isVisible())) continue;
    const placeholder = await inp.getAttribute('placeholder') || '';
    const value = await inp.inputValue().catch(() => '');
    // The name input has no placeholder (empty string) and empty value
    if (placeholder === '' && value === '') {
      await inp.click();
      await inp.fill(safeAppName);
      const afterVal = await inp.inputValue();
      if (afterVal === safeAppName) {
        bus.sendLog(`成功填入应用名称 (input index ${i})`);
        nameInputFilled = true;
        break;
      }
    }
  }
  if (!nameInputFilled) {
    throw new Error('无法找到应用名称输入框');
  }

  // Fill description — first visible textarea
  if (safeAppDescription !== appDescription) {
    bus.sendLog('应用描述超过 120 字符，已自动截断');
  } else {
    bus.sendLog(`填入应用描述: ${safeAppDescription}`);
  }
  const descInput = page.locator('textarea').first();
  await descInput.waitFor({ timeout: 5000 });
  await descInput.fill(safeAppDescription);

  // Click "创建"
  bus.sendLog('点击"创建"...');
  await page.getByRole('button', { name: S.createApp.confirmButton, exact: true }).click();

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
