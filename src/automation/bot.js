const S = require('./selectors');
const { dismissModals } = require('./dismiss-modals');
const fs = require('fs');
const path = require('path');
const { LOG_DIR } = require('../utils/paths');

async function enableBot(page, bus, appId) {
  bus.sendPhase('bot', 'running', '正在开启机器人能力...');

  await page.goto(S.urls.credentials(appId), { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);
  await dismissModals(page, bus);
  await page.waitForTimeout(1000);

  // Check if "机器人" link already exists in sidebar (precise check)
  const hasBotInSidebar = await checkBotSidebar(page);

  if (hasBotInSidebar) {
    bus.sendLog('机器人能力已启用（侧边栏确认）');
    bus.sendPhase('bot', 'done', '机器人能力已启用');
    return;
  }

  // Click "添加应用能力"
  bus.sendLog('点击"添加应用能力"...');
  await page.getByText(S.sidebar.addAbility).first().click();
  await page.waitForTimeout(3000);
  await dismissModals(page, bus);

  // Screenshot
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    await page.screenshot({ path: path.join(LOG_DIR, 'bot-ability-page.png'), fullPage: true });
  } catch {}

  // Find the "机器人" card's "添加" button using position-based approach
  // The card has: image → title "机器人" → description → "+ 添加" button
  bus.sendLog('定位"机器人"卡片的"添加"按钮...');

  const addBtnPos = await page.evaluate(() => {
    // Find the heading element that says exactly "机器人"
    const headings = Array.from(document.querySelectorAll('*'));
    for (const h of headings) {
      if (h.childElementCount > 1) continue; // Skip containers
      const text = h.textContent.trim();
      if (text !== '机器人') continue;
      if (!h.offsetParent) continue;

      // Found the title. Look for the "添加" button below it in the same card.
      const titleRect = h.getBoundingClientRect();

      // Search nearby clickable elements below the title
      const candidates = Array.from(document.querySelectorAll('*'));
      for (const c of candidates) {
        const cText = c.textContent.trim();
        if (!cText.includes('添加') || cText.length > 10) continue;
        if (!c.offsetParent) continue;

        const cRect = c.getBoundingClientRect();
        // Must be below the title and roughly aligned horizontally
        if (cRect.top > titleRect.top &&
            cRect.top - titleRect.top < 200 &&
            Math.abs(cRect.left - titleRect.left) < 200) {
          return {
            x: Math.round(cRect.x + cRect.width / 2),
            y: Math.round(cRect.y + cRect.height / 2),
            text: cText,
          };
        }
      }
    }
    return null;
  });

  if (!addBtnPos) {
    // Fallback: maybe "机器人" already added but page didn't refresh
    bus.sendLog('未找到"添加"按钮 — 机器人可能已添加');
    await page.screenshot({ path: path.join(LOG_DIR, 'bot-add-not-found.png'), fullPage: true });
    throw new Error('未找到机器人的"添加"按钮');
  }

  bus.sendLog(`点击"${addBtnPos.text}"按钮 at (${addBtnPos.x}, ${addBtnPos.y})...`);
  await page.mouse.click(addBtnPos.x, addBtnPos.y);
  await page.waitForTimeout(3000);

  // Handle confirmation dialog
  for (const text of ['确认', '确定', '开通']) {
    try {
      const btn = page.getByRole('button', { name: text });
      if (await btn.count() > 0 && await btn.first().isVisible()) {
        await btn.first().click();
        bus.sendLog(`点击了确认: "${text}"`);
        await page.waitForTimeout(2000);
        break;
      }
    } catch {}
  }

  await dismissModals(page, bus);
  await page.waitForTimeout(2000);

  // Take post-action screenshot
  try {
    await page.screenshot({ path: path.join(LOG_DIR, 'bot-after-add.png'), fullPage: true });
  } catch {}

  // VERIFY: navigate back and check sidebar
  await page.goto(S.urls.credentials(appId), { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);
  await dismissModals(page, bus);

  const verified = await checkBotSidebar(page);
  if (verified) {
    bus.sendLog('验证通过：侧边栏已出现"机器人"链接');
  } else {
    try {
      await page.screenshot({ path: path.join(LOG_DIR, 'bot-verify-failed.png'), fullPage: true });
    } catch {}
    throw new Error('机器人能力添加失败：侧边栏未出现"机器人"链接');
  }

  bus.sendPhase('bot', 'done', '机器人能力已启用');
}

async function checkBotSidebar(page) {
  return page.evaluate(() => {
    // Check specifically in the sidebar nav area for an exact "机器人" link
    const allEl = Array.from(document.querySelectorAll('a, [role="menuitem"], [role="treeitem"]'));
    for (const el of allEl) {
      if (el.textContent.trim() === '机器人' && el.offsetParent !== null) {
        return true;
      }
    }
    // Also check: if the page has "删除能力" text near "机器人", it means it's already added
    const body = document.body.textContent;
    if (body.includes('机器人') && body.includes('删除能力')) {
      return true;
    }
    return false;
  });
}

module.exports = { enableBot };
