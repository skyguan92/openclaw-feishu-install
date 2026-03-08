/**
 * Quick exploration of the credentials page DOM.
 * Reuses the existing app cli_a926fc698b78dcc4.
 * Dumps detailed info about elements near App Secret.
 */

const { chromium } = require('playwright');

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

  console.log('>>> 请登录飞书...');
  await page.goto('https://open.feishu.cn/app', { waitUntil: 'domcontentloaded' });

  while (true) {
    if (/open\.feishu\.cn\/app\/?$/.test(page.url())) {
      await page.waitForTimeout(2000);
      if (/open\.feishu\.cn\/app\/?$/.test(page.url())) break;
    }
    await page.waitForTimeout(2000);
  }
  console.log('>>> 登录成功');

  // Navigate to the credentials page
  await page.goto('https://open.feishu.cn/app/cli_a926fc698b78dcc4/baseinfo', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  // Dump detailed info about the credentials section using page.evaluate
  const info = await page.evaluate(() => {
    const results = {};

    // Find all text nodes containing "App Secret"
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const secretNodes = [];
    while (walker.nextNode()) {
      if (walker.currentNode.textContent.includes('App Secret')) {
        secretNodes.push({
          text: walker.currentNode.textContent.trim(),
          parentTag: walker.currentNode.parentElement?.tagName,
          parentClass: walker.currentNode.parentElement?.className?.substring(0, 80),
          grandparentTag: walker.currentNode.parentElement?.parentElement?.tagName,
        });
      }
    }
    results.secretTextNodes = secretNodes;

    // Find the "应用凭证" section and dump its structure
    const credSection = document.querySelector('[class*="credential"], [class*="cert"]');
    if (credSection) {
      results.credSectionHTML = credSection.outerHTML.substring(0, 2000);
    }

    // Find ALL icon-like elements (svg, img, i, span with icon class) near App Secret
    const allElements = document.querySelectorAll('svg, [class*="icon"], [class*="Icon"]');
    const iconInfo = [];
    for (const el of allElements) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      // Only elements in the right area (x > 600 for App Secret section, y < 400 for top area)
      if (rect.x > 600 && rect.y > 100 && rect.y < 400) {
        iconInfo.push({
          tag: el.tagName,
          class: el.className?.baseVal || el.className?.substring?.(0, 60) || '',
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
          parentTag: el.parentElement?.tagName,
          parentClass: el.parentElement?.className?.substring?.(0, 60) || '',
          // Check if this looks like an eye icon (common SVG paths for eye)
          svgContent: el.tagName === 'svg' ? el.innerHTML.substring(0, 200) : '',
        });
      }
    }
    results.iconsNearSecret = iconInfo;

    // Also dump the masked secret text and its siblings
    const allSpans = document.querySelectorAll('span, div');
    const starTexts = [];
    for (const el of allSpans) {
      if (el.textContent.includes('****') || el.textContent.match(/^\*{5,}$/)) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0) {
          starTexts.push({
            text: el.textContent.trim().substring(0, 50),
            tag: el.tagName,
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            nextSiblingTag: el.nextElementSibling?.tagName,
            nextSiblingClass: el.nextElementSibling?.className?.substring?.(0, 60),
          });
        }
      }
    }
    results.maskedSecretElements = starTexts;

    return results;
  });

  console.log('\n=== Secret Text Nodes ===');
  console.log(JSON.stringify(info.secretTextNodes, null, 2));

  console.log('\n=== Icons Near App Secret ===');
  console.log(JSON.stringify(info.iconsNearSecret, null, 2));

  console.log('\n=== Masked Secret Elements ===');
  console.log(JSON.stringify(info.maskedSecretElements, null, 2));

  // Now try clicking the eye icon and see what happens
  console.log('\n=== Attempting to click eye icon ===');

  // The 3 icons after the **** text should be: copy, eye, refresh
  // They are likely SVGs inside clickable spans/buttons
  // Let's locate them by position: they should be right of the masked text
  const secretRow = page.locator('text=App Secret').locator('..').locator('..');
  const svgsInRow = secretRow.locator('svg');
  const svgCount = await svgsInRow.count();
  console.log(`SVGs in App Secret row: ${svgCount}`);

  for (let i = 0; i < svgCount; i++) {
    const svg = svgsInRow.nth(i);
    const box = await svg.boundingBox();
    console.log(`  SVG[${i}]: x=${box?.x}, y=${box?.y}, w=${box?.width}, h=${box?.height}`);
  }

  // The eye icon is typically the 2nd SVG (after copy)
  if (svgCount >= 2) {
    console.log('Clicking SVG[1] (expected eye icon)...');
    await svgsInRow.nth(1).click();
    await page.waitForTimeout(2000);

    // Check if secret is now visible
    const bodyText = await page.textContent('body');
    const secretMatch = bodyText.match(/([a-zA-Z0-9]{20,})/g);
    if (secretMatch) {
      console.log('Found potential secrets:', secretMatch.filter(s => s !== 'cli_a926fc698b78dcc4'));
    }
  }

  console.log('\n>>> Done. Press Ctrl+C to exit.');
  await new Promise(() => {});
}

main().catch(console.error);
