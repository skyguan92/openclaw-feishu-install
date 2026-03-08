/**
 * Feishu UI Explorer
 *
 * Launches a headed Chrome browser. After you log in manually,
 * it navigates through each page of the Feishu developer console,
 * takes screenshots, and dumps key DOM info (inputs, buttons, labels, textareas).
 *
 * This gives us the real selectors to fix the automation.
 *
 * Usage: node test/explore-feishu.js
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, 'explore-output');
fs.mkdirSync(OUT_DIR, { recursive: true });

async function dumpPageInfo(page, name) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  Exploring: ${name}`);
  console.log(`  URL: ${page.url()}`);
  console.log('='.repeat(60));

  // Screenshot
  const ssPath = path.join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: ssPath, fullPage: true });
  console.log(`  Screenshot: ${ssPath}`);

  // Dump all visible inputs
  const inputs = await page.locator('input').all();
  console.log(`\n  Inputs (${inputs.length}):`);
  for (let i = 0; i < inputs.length; i++) {
    try {
      const inp = inputs[i];
      const visible = await inp.isVisible().catch(() => false);
      if (!visible) continue;
      const type = await inp.getAttribute('type') || 'text';
      const placeholder = await inp.getAttribute('placeholder') || '';
      const name_ = await inp.getAttribute('name') || '';
      const maxlen = await inp.getAttribute('maxlength') || '';
      const value = await inp.inputValue().catch(() => '');
      const ariaLabel = await inp.getAttribute('aria-label') || '';
      console.log(`    [${i}] type=${type} placeholder="${placeholder}" name="${name_}" maxlength=${maxlen} value="${value}" aria-label="${ariaLabel}"`);
    } catch {}
  }

  // Dump all visible textareas
  const textareas = await page.locator('textarea').all();
  console.log(`\n  Textareas (${textareas.length}):`);
  for (let i = 0; i < textareas.length; i++) {
    try {
      const ta = textareas[i];
      const visible = await ta.isVisible().catch(() => false);
      if (!visible) continue;
      const placeholder = await ta.getAttribute('placeholder') || '';
      const maxlen = await ta.getAttribute('maxlength') || '';
      console.log(`    [${i}] placeholder="${placeholder}" maxlength=${maxlen}`);
    } catch {}
  }

  // Dump all visible buttons
  const buttons = await page.locator('button').all();
  console.log(`\n  Buttons (${buttons.length} total, showing visible):`);
  for (let i = 0; i < buttons.length; i++) {
    try {
      const btn = buttons[i];
      const visible = await btn.isVisible().catch(() => false);
      if (!visible) continue;
      const text = (await btn.textContent()).trim().substring(0, 50);
      const ariaLabel = await btn.getAttribute('aria-label') || '';
      const disabled = await btn.isDisabled().catch(() => false);
      console.log(`    [${i}] "${text}" aria-label="${ariaLabel}" disabled=${disabled}`);
    } catch {}
  }

  // Dump key role-based elements
  const links = await page.getByRole('link').all();
  const tabs = await page.getByRole('tab').all();
  console.log(`\n  Links: ${links.length}, Tabs: ${tabs.length}`);
}

async function main() {
  const browser = await chromium.launch({
    headless: false,
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: 'zh-CN',
  });
  const page = await context.newPage();

  // Step 1: Navigate to Feishu and wait for login
  console.log('\n>>> 请在浏览器中登录飞书，登录成功后自动继续...');
  await page.goto('https://open.feishu.cn/app', { waitUntil: 'domcontentloaded' });

  // Poll for login
  while (true) {
    const url = page.url();
    if (/open\.feishu\.cn\/app\/?$/.test(url)) {
      await page.waitForTimeout(2000);
      if (/open\.feishu\.cn\/app\/?$/.test(page.url())) {
        console.log('>>> 登录成功！');
        break;
      }
    }
    await page.waitForTimeout(2000);
  }

  // ── Explore: App List page ──
  await dumpPageInfo(page, '01-app-list');

  // ── Explore: Click "创建企业自建应用" to open modal ──
  console.log('\n>>> 点击"创建企业自建应用"...');
  await page.getByText('创建企业自建应用').click();
  await page.waitForTimeout(2000);
  await dumpPageInfo(page, '02-create-app-modal');

  // ── Close the modal and use an existing app for further exploration ──
  // Press Escape or click cancel
  try {
    await page.getByRole('button', { name: '取消' }).click();
    await page.waitForTimeout(1000);
  } catch {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1000);
  }

  // Find an existing app to explore its sub-pages
  // Look for app links on the page
  const appLinks = await page.locator('a[href*="/app/cli_"]').all();
  let existingAppId = null;
  if (appLinks.length > 0) {
    const href = await appLinks[0].getAttribute('href');
    const match = href.match(/\/app\/(cli_[a-zA-Z0-9]+)/);
    if (match) existingAppId = match[1];
  }

  if (!existingAppId) {
    console.log('\n>>> 没有现有应用，创建一个测试应用...');
    // Re-open modal and create
    await page.getByText('创建企业自建应用').click();
    await page.waitForTimeout(2000);

    // Try filling the first visible empty input
    const allInputs = await page.locator('input').all();
    for (const inp of allInputs) {
      if (await inp.isVisible() && (await inp.inputValue()) === '') {
        await inp.fill('ExploreTest');
        break;
      }
    }
    // Fill textarea
    const ta = page.locator('textarea').first();
    if (await ta.isVisible()) {
      await ta.fill('Explorer test app');
    }
    // Click 创建
    await page.getByRole('button', { name: '创建' }).click();
    await page.waitForURL(/\/app\/cli_/, { timeout: 15000 });
    const match = page.url().match(/\/app\/(cli_[a-zA-Z0-9]+)/);
    existingAppId = match ? match[1] : null;
    console.log(`>>> 创建了测试应用: ${existingAppId}`);
  } else {
    console.log(`\n>>> 使用现有应用: ${existingAppId}`);
  }

  if (!existingAppId) {
    console.log('>>> 无法获取应用 ID，退出');
    await browser.close();
    return;
  }

  // ── Explore: Credentials page ──
  console.log('\n>>> 导航到凭证页...');
  await page.goto(`https://open.feishu.cn/app/${existingAppId}/baseinfo`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  await dumpPageInfo(page, '03-credentials');

  // ── Explore: Bot ability page ──
  console.log('\n>>> 导航到机器人页...');
  await page.goto(`https://open.feishu.cn/app/${existingAppId}/bot`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  await dumpPageInfo(page, '04-bot');

  // Also check the ability page
  await page.goto(`https://open.feishu.cn/app/${existingAppId}/ability`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  await dumpPageInfo(page, '04b-ability');

  // ── Explore: Permissions page ──
  console.log('\n>>> 导航到权限页...');
  await page.goto(`https://open.feishu.cn/app/${existingAppId}/permission/scope/list`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  await dumpPageInfo(page, '05-permissions');

  // ── Explore: Events page ──
  console.log('\n>>> 导航到事件订阅页...');
  await page.goto(`https://open.feishu.cn/app/${existingAppId}/event/config`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  await dumpPageInfo(page, '06-events');

  // ── Explore: Version/Release page ──
  console.log('\n>>> 导航到版本发布页...');
  await page.goto(`https://open.feishu.cn/app/${existingAppId}/version`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  await dumpPageInfo(page, '07-version');

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  探索完成！所有截图和 DOM 信息保存在: ${OUT_DIR}`);
  console.log(`  应用 ID: ${existingAppId}`);
  console.log('='.repeat(60));

  // Keep browser open for manual inspection
  console.log('\n>>> 浏览器保持打开，按 Ctrl+C 退出');
  await new Promise(() => {}); // hang forever
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
