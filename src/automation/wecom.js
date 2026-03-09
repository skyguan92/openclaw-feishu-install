const LOGIN_URL = 'https://work.weixin.qq.com/wework_admin/loginpage_wx';
const ROBOT_LIST_URL = 'https://work.weixin.qq.com/wework_admin/frame#/aiHelper/list?from=manage_tools';
const CREATE_URL_FRAGMENT = '#/aiHelper/create';
const DETAIL_URL_PATTERN = /#\/aiHelper\/detail/;
const FRAME_URL_PATTERN = /\/wework_admin\/frame#/;
const LOGIN_URL_PATTERN = /loginpage_wx/;

function normalizeLines(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function getLineAfter(lines, label) {
  const index = lines.findIndex((line) => line === label);
  if (index === -1) {
    return '';
  }

  for (let i = index + 1; i < lines.length; i += 1) {
    const value = lines[i];
    if (!value || value === label || value === '点击获取') {
      continue;
    }
    return value;
  }

  return '';
}

function parseCredentialsFromText(text) {
  const lines = normalizeLines(text);
  return {
    botId: getLineAfter(lines, 'Bot ID'),
    botSecret: getLineAfter(lines, 'Secret'),
  };
}

function isLoggedInUrl(url) {
  return FRAME_URL_PATTERN.test(url) && !LOGIN_URL_PATTERN.test(url);
}

async function safeGoto(page, url, bus) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (err) {
    if (bus) {
      bus.sendLog(`页面加载较慢: ${err.message}，继续等待...`);
    }
  }

  await page.waitForTimeout(2500);
}

async function clickVisible(locator) {
  const count = await locator.count();
  for (let i = 0; i < count; i += 1) {
    const item = locator.nth(i);
    if (await item.isVisible()) {
      await item.click();
      return true;
    }
  }
  return false;
}

async function waitForVisible(locator, timeout = 60000) {
  await locator.first().waitFor({ state: 'visible', timeout });
}

async function clickCreateRobot(page) {
  const button = page.getByRole('button', { name: '创建机器人', exact: true });
  if (await clickVisible(button)) {
    return;
  }

  const text = page.getByText('创建机器人', { exact: true });
  if (await clickVisible(text)) {
    return;
  }

  throw new Error('未找到“创建机器人”入口');
}

async function waitForWecomLogin(page, bus, options = {}) {
  const reportPhase = options.reportPhase !== false;

  bus.sendLog('导航到企业微信智能机器人后台...');
  await safeGoto(page, ROBOT_LIST_URL, bus);

  if (isLoggedInUrl(page.url())) {
    if (reportPhase) {
      bus.sendPhase('login', 'done', '企业微信登录有效');
    }
    bus.sendLog('已确认企业微信登录状态有效');
    return;
  }

  if (reportPhase) {
    bus.sendPhase('login', 'waiting', '请在弹出的企业微信页面扫码登录');
  }
  bus.sendLog(`未检测到登录态，已打开扫码页: ${LOGIN_URL}`);

  const maxWaitMs = 10 * 60 * 1000;
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    if (isLoggedInUrl(page.url())) {
      await page.waitForTimeout(2000);
      if (reportPhase) {
        bus.sendPhase('login', 'done', '扫码登录成功');
      }
      bus.sendLog('已检测到企业微信登录成功');
      await safeGoto(page, ROBOT_LIST_URL, bus);
      return;
    }

    await page.waitForTimeout(2000);
  }

  throw new Error('企业微信扫码登录超时（10分钟）');
}

async function openRobotCreatePage(page, bus) {
  bus.sendLog('进入企业微信智能机器人列表...');
  await safeGoto(page, ROBOT_LIST_URL, bus);
  await waitForVisible(page.getByText('创建机器人', { exact: true }));

  bus.sendLog('开始创建企业微信智能机器人...');
  await clickCreateRobot(page);
  await page.waitForTimeout(1200);

  const manualCreate = page.getByText('手动创建', { exact: true });
  if (await clickVisible(manualCreate)) {
    await page.waitForTimeout(1200);
  }

  const start = Date.now();
  while (!page.url().includes(CREATE_URL_FRAGMENT)) {
    if (Date.now() - start > 60000) {
      throw new Error('未能进入企业微信机器人创建页面');
    }
    await page.waitForTimeout(1000);
  }

  bus.sendLog('已进入企业微信机器人创建页');
}

async function switchToApiMode(page, bus) {
  const apiModeEntry = page.getByText('API 模式创建', { exact: false });
  if (await clickVisible(apiModeEntry)) {
    await page.waitForTimeout(1500);
  }

  await waitForVisible(page.getByText('Bot ID', { exact: true }));
  bus.sendLog('已切换到 API 长连接创建模式');
}

async function editRobotInfo(page, bus, options) {
  const botName = String(options.botName || '').trim();
  if (!botName) {
    throw new Error('创建企业微信机器人前需要提供机器人名称');
  }

  const intro = String(options.description || 'Powered by OpenClaw').trim();
  await page.locator('.edit_title_button').first().click();
  await page.waitForTimeout(800);

  const dialog = page.locator('.t-dialog:visible').filter({ hasText: '编辑智能机器人信息' }).last();
  await waitForVisible(dialog);
  await dialog.locator('input[placeholder="输入智能机器人名称"]').fill(botName);

  const introInput = dialog.locator('textarea[placeholder="输入简介让大家快速了解智能机器人能做什么"]');
  if (await introInput.count()) {
    await introInput.fill(intro);
  }

  await dialog.getByRole('button', { name: '确定', exact: true }).click();
  await page.waitForTimeout(1500);

  const currentName = await page.locator('.robot_title').last().innerText().catch(() => '');
  if (!currentName.includes(botName)) {
    throw new Error('企业微信机器人名称保存失败');
  }

  bus.sendLog(`机器人名称已设置: ${botName}`);
}

async function revealCredentials(page, bus) {
  const revealSecretButton = page.getByText('点击获取', { exact: true });
  const secretButtonVisible = await revealSecretButton.count()
    && await revealSecretButton.first().isVisible().catch(() => false);
  if (secretButtonVisible) {
    await revealSecretButton.first().click();
    await page.waitForTimeout(1200);
  }

  let credentials = parseCredentialsFromText(await page.locator('body').innerText());
  const start = Date.now();
  while (Date.now() - start < 30000) {
    credentials = parseCredentialsFromText(await page.locator('body').innerText());
    if (credentials.botId && credentials.botSecret) {
      bus.sendLog(`已提取企业微信 Bot ID: ${credentials.botId}`);
      return credentials;
    }
    await page.waitForTimeout(500);
  }

  throw new Error('未能从企业微信页面提取 Bot ID / Secret');
}

async function configureVisibleScope(page, bus) {
  await page.getByText('添加', { exact: true }).first().click();
  await page.waitForTimeout(1200);

  const scopeDialog = page.locator('.qui_dialog:visible').filter({ hasText: '设置可见范围' }).last();
  await waitForVisible(scopeDialog);

  const selectedPanel = scopeDialog.locator('.js_right_col');
  let selectedText = (await selectedPanel.innerText()).trim();

  if (!selectedText) {
    const candidates = scopeDialog.locator('#partyTree .jstree-anchor');
    const count = await candidates.count();
    if (!count) {
      throw new Error('企业微信可见范围弹窗中未找到可选成员');
    }

    const target = count > 1 ? candidates.nth(count - 1) : candidates.first();
    await target.click();
    await page.waitForTimeout(800);
    selectedText = (await selectedPanel.innerText()).trim();
  }

  if (!selectedText) {
    throw new Error('企业微信可见范围未选择成功');
  }

  await scopeDialog.getByText('确认', { exact: true }).click();
  await page.waitForTimeout(1200);
  bus.sendLog(`可见范围已设置: ${selectedText}`);
}

async function saveBot(page, bus) {
  const saveButton = page.getByRole('button', { name: '保存', exact: true }).last();
  await saveButton.scrollIntoViewIfNeeded().catch(() => {});
  await saveButton.click();
  await page.waitForTimeout(2000);

  if (!DETAIL_URL_PATTERN.test(page.url())) {
    await saveButton.click({ force: true }).catch(async () => {
      await saveButton.evaluate((node) => node.click());
    });
    await page.waitForTimeout(2000);
  }

  const domainDialog = page.locator('.t-dialog:visible').filter({ hasText: '配置 API 模式域名' }).last();
  const domainDialogVisible = await domainDialog.isVisible().catch(() => false);
  if (domainDialogVisible) {
    await domainDialog.getByRole('button', { name: '保存', exact: true }).click();
    await page.waitForTimeout(1000);
  }

  const start = Date.now();
  while (!DETAIL_URL_PATTERN.test(page.url())) {
    if (Date.now() - start > 60000) {
      throw new Error('企业微信机器人保存后未进入详情页');
    }
    await page.waitForTimeout(1000);
  }

  bus.sendLog('企业微信机器人已保存，进入详情页');
}

async function createWecomBot(page, bus, options = {}) {
  await openRobotCreatePage(page, bus);
  await switchToApiMode(page, bus);
  await editRobotInfo(page, bus, options);
  await revealCredentials(page, bus);
  await configureVisibleScope(page, bus);
  await saveBot(page, bus);

  const credentials = await revealCredentials(page, bus);
  return {
    ...credentials,
    detailUrl: page.url(),
  };
}

module.exports = {
  LOGIN_URL,
  ROBOT_LIST_URL,
  createWecomBot,
  parseCredentialsFromText,
  waitForWecomLogin,
};
