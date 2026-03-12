const S = require('./selectors');
const { buildFeishuUrl } = require('../config/feishu-domain');

async function waitForLogin(page, bus, options = {}) {
  const reportPhase = options.reportPhase !== false;

  bus.sendLog('导航到飞书开放平台...');

  // Navigate with generous timeout; catch timeout errors gracefully
  // since the page may still be usable even after a partial load.
  try {
    await page.goto(S.urls.appList, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (err) {
    bus.sendLog(`页面加载较慢: ${err.message}，继续等待...`);
  }

  // Wait for page to settle after redirects
  await page.waitForTimeout(3000);

  // Check if already logged in
  const initialUrl = page.url();
  bus.sendLog(`当前 URL: ${initialUrl}`);

  if (S.login.loggedInUrlPattern.test(initialUrl)) {
    const loginContext = await fetchLoginContext(page, bus);
    if (reportPhase) {
      bus.sendPhase('login', 'done', '登录有效');
    }
    bus.sendLog('已确认飞书登录状态有效');
    return loginContext;
  }

  const credentialAttempted = await tryCredentialLogin(page, bus);
  if (credentialAttempted) {
    if (reportPhase) {
      bus.sendPhase('login', 'waiting', '正在尝试账号密码登录，请在浏览器中处理验证码或二次确认');
    }
    bus.sendLog('已检测到 FEISHU_LOGIN_ID / FEISHU_LOGIN_PASSWORD，等待登录完成...');
  } else {
    if (reportPhase) {
      bus.sendPhase('login', 'waiting', '请在 Playwright 浏览器中扫码登录飞书');
    }
    bus.sendLog('等待扫码登录（5分钟超时）...');
  }

  const maxWait = 5 * 60 * 1000; // 5 minutes
  const pollInterval = 3000;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    const url = page.url();
    if (S.login.loggedInUrlPattern.test(url)) {
      // Wait extra time for the page to stabilize and user to finish confirming
      bus.sendLog('检测到可能已登录，等待确认...');
      await page.waitForTimeout(3000);
      const currentUrl = page.url();
      if (S.login.loggedInUrlPattern.test(currentUrl)) {
      if (reportPhase) {
          bus.sendPhase('login', 'done', '登录成功');
        }
        bus.sendLog('已检测到飞书登录成功');
        return fetchLoginContext(page, bus);
      }
    }
    await page.waitForTimeout(pollInterval);
  }

  throw new Error('登录超时（5分钟），请重试');
}

async function fetchLoginContext(page, bus) {
  try {
    const loginCheckUrl = buildFeishuUrl('/napi/check/login');
    const result = await page.evaluate(async (targetUrl) => {
      const response = await fetch(targetUrl, {
        credentials: 'include',
        headers: {
          Accept: 'application/json, text/plain, */*',
        },
      });

      return response.json();
    }, loginCheckUrl);

    if (result && result.code === 0 && result.data) {
      if (bus) {
        bus.sendLog(`已识别当前飞书操作者 userId=${result.data.id}`);
      }
      return {
        userId: result.data.id || '',
        tenantId: result.data.tenantId || '',
      };
    }
  } catch (err) {
    if (bus) {
      bus.sendLog(`读取当前飞书登录上下文失败: ${err.message}`);
    }
  }

  return null;
}

async function tryCredentialLogin(page, bus) {
  const loginId = process.env.FEISHU_LOGIN_ID || process.env.FEISHU_EMAIL || process.env.LARK_LOGIN_ID;
  const password = process.env.FEISHU_LOGIN_PASSWORD || process.env.FEISHU_PASSWORD || process.env.LARK_LOGIN_PASSWORD;

  if (!loginId || !password) {
    return false;
  }

  try {
    await page.waitForTimeout(2000);
    await clickFirstVisible(page, ['邮箱登录', '账号登录', '密码登录']);

    const accountInput = await findInput(page, S.login.accountHints, ['password']);
    if (accountInput) {
      await accountInput.fill(loginId);
      await page.waitForTimeout(500);
    }

    let passwordInput = await findPasswordInput(page);
    if (!passwordInput) {
      await clickFirstVisible(page, S.login.nextButtons);
      await page.waitForTimeout(1500);
      passwordInput = await findPasswordInput(page);
    }

    if (!passwordInput) {
      bus.sendLog('未能自动定位飞书密码输入框，将回退为手动登录');
      return false;
    }

    await passwordInput.fill(password);
    await page.waitForTimeout(500);
    await clickFirstVisible(page, ['登录', '继续', '下一步']);
    return true;
  } catch (err) {
    bus.sendLog(`自动填充登录表单失败: ${err.message}`);
    return false;
  }
}

async function findInput(page, includeHints, excludeHints = []) {
  const inputs = page.locator('input:visible');
  const total = await inputs.count();

  for (let i = 0; i < total; i++) {
    const input = inputs.nth(i);
    const type = ((await input.getAttribute('type')) || 'text').toLowerCase();
    if (excludeHints.includes(type)) {
      continue;
    }

    const placeholder = `${await input.getAttribute('placeholder') || ''} ${await input.getAttribute('aria-label') || ''} ${await input.getAttribute('name') || ''}`.toLowerCase();
    if (!includeHints.some((hint) => placeholder.includes(hint.toLowerCase()))) {
      continue;
    }

    return input;
  }

  return null;
}

async function findPasswordInput(page) {
  const inputs = page.locator('input[type="password"]:visible');
  if (await inputs.count()) {
    return inputs.first();
  }

  return findInput(page, S.login.passwordHints);
}

async function clickFirstVisible(page, labels) {
  for (const label of labels) {
    const button = page.getByRole('button', { name: label, exact: false });
    if (await button.count()) {
      const first = button.first();
      if (await first.isVisible()) {
        await first.click();
        return true;
      }
    }

    const text = page.getByText(label, { exact: false });
    if (await text.count()) {
      const first = text.first();
      if (await first.isVisible()) {
        await first.click();
        return true;
      }
    }
  }

  return false;
}

module.exports = {
  fetchLoginContext,
  waitForLogin,
};
