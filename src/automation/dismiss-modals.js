const DISMISS_TEXTS = ['我知道了', '知道了', '好的', '下次再说', 'Got it', '跳过'];

async function dismissModals(page, bus) {
  for (const text of DISMISS_TEXTS) {
    try {
      const btn = page.getByRole('button', { name: text, exact: true });
      if (await btn.count() > 0 && await btn.first().isVisible()) {
        await btn.first().click();
        if (bus) bus.sendLog(`关闭弹窗: "${text}"`);
        await page.waitForTimeout(500);
      }
    } catch {}
  }
}

module.exports = { dismissModals, DISMISS_TEXTS };
