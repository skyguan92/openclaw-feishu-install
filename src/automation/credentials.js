const S = require('./selectors');
const { dismissModals } = require('./dismiss-modals');
const fs = require('fs');
const path = require('path');
const { LOG_DIR } = require('../utils/paths');
const DEBUG_FILE = path.join(LOG_DIR, 'credentials-debug.log');
const HTML_FILE = path.join(LOG_DIR, 'credentials-page.html');

function debugLog(msg) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(DEBUG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
}

async function extractCredentials(page, bus, appId) {
  try { fs.writeFileSync(DEBUG_FILE, ''); } catch {}

  bus.sendPhase('credentials', 'running', '正在获取应用凭证...');
  bus.sendLog(`App ID: ${appId}`);
  debugLog(`App ID: ${appId}`);

  // Grant clipboard permissions
  try {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  } catch {}

  // ── Set up network interception BEFORE navigating ──
  let secretFromNetwork = null;
  const capturedUrls = [];

  page.on('response', async (response) => {
    try {
      const url = response.url();
      const contentType = response.headers()['content-type'] || '';
      if (contentType.includes('json') && (url.includes('open.feishu.cn') || url.includes('open.larksuite.com'))) {
        capturedUrls.push(url);
        const text = await response.text();
        debugLog(`API response: ${url.substring(0, 150)}`);
        debugLog(`  body preview: ${text.substring(0, 300)}`);
        const patterns = [
          /"app_secret"\s*:\s*"([^"]{20,})"/,
          /"appSecret"\s*:\s*"([^"]{20,})"/,
          /"secret"\s*:\s*"([^"]{20,})"/,
        ];
        for (const pattern of patterns) {
          const match = text.match(pattern);
          if (match && !match[1].startsWith('cli_')) {
            secretFromNetwork = match[1];
            debugLog(`FOUND SECRET IN API RESPONSE!`);
          }
        }
      }
    } catch {}
  });

  await page.goto(S.urls.credentials(appId), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);

  // Dismiss any upgrade guide / announcement modals
  await dismissModals(page, bus);

  debugLog(`Captured ${capturedUrls.length} API URLs`);
  capturedUrls.forEach(u => debugLog(`  ${u}`));

  if (secretFromNetwork) {
    bus.sendPhase('credentials', 'done', '凭证获取成功（网络拦截）');
    bus.sendLog(`App Secret: ${secretFromNetwork.substring(0, 6)}...`);
    debugLog(`SUCCESS via network: ${secretFromNetwork.substring(0, 6)}...`);
    return { appId, appSecret: secretFromNetwork };
  }

  // ── Save full page HTML for offline analysis ──
  try {
    const fullHtml = await page.content();
    fs.writeFileSync(HTML_FILE, fullHtml);
    debugLog(`Saved full HTML to ${HTML_FILE} (${fullHtml.length} bytes)`);
  } catch (err) {
    debugLog(`Failed to save HTML: ${err.message}`);
  }

  // ── SVG and label analysis ──
  const svgInfo = await page.evaluate(() => {
    const svgs = Array.from(document.querySelectorAll('svg'));
    return svgs.map((svg, i) => {
      let clickableEl = null;
      let el = svg;
      for (let depth = 0; depth < 6; depth++) {
        if (!el) break;
        if (window.getComputedStyle(el).cursor === 'pointer') {
          clickableEl = el;
          break;
        }
        el = el.parentElement;
      }
      const rect = svg.getBoundingClientRect();
      return {
        i,
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
        clickable: !!clickableEl,
        clickableTag: clickableEl?.tagName,
        clickableCls: clickableEl?.className?.toString().substring(0, 80),
        parentCls: svg.parentElement?.className?.toString().substring(0, 80),
        title: svg.parentElement?.getAttribute('title') || svg.parentElement?.getAttribute('aria-label') || '',
      };
    });
  });
  debugLog(`Total SVGs: ${svgInfo.length}`);
  svgInfo.forEach(s => debugLog(`  SVG[${s.i}] (${s.x},${s.y}) ${s.w}x${s.h} click=${s.clickable} tag=${s.clickableTag} cls=${s.clickableCls} pcls=${s.parentCls} title="${s.title}"`));

  const labelInfo = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('*'));
    const results = [];
    for (const el of all) {
      const text = el.textContent.trim();
      if (text.includes('App Secret') && text.length < 50) {
        const rect = el.getBoundingClientRect();
        results.push({
          tag: el.tagName,
          text: text.substring(0, 40),
          children: el.children.length,
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          right: Math.round(rect.right),
          bottom: Math.round(rect.bottom),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
        });
      }
    }
    return results;
  });
  debugLog(`Elements containing "App Secret": ${JSON.stringify(labelInfo, null, 2)}`);

  // Find the smallest element that is likely the label itself
  const label = labelInfo.find(l => l.children <= 1 && l.text.length < 30) || labelInfo[0];
  debugLog(`Selected label: ${JSON.stringify(label)}`);

  let appSecret = null;

  // ── Strategy A: Position-based SVG click ──
  if (label && svgInfo.length > 0) {
    debugLog('Strategy A: Position-based SVG click');

    const candidateSvgs = svgInfo.filter(s =>
      s.clickable &&
      s.x > label.right &&
      Math.abs(s.y - label.y) < 80
    ).sort((a, b) => a.x - b.x);

    debugLog(`Candidates: ${candidateSvgs.length}`);
    candidateSvgs.forEach(s => debugLog(`  SVG[${s.i}] (${s.x},${s.y})`));

    if (candidateSvgs.length >= 1) {
      const target = candidateSvgs[0];
      debugLog(`Clicking SVG[${target.i}] at (${target.x + target.w/2}, ${target.y + target.h/2})`);

      try { await page.evaluate(() => navigator.clipboard.writeText('')); } catch {}
      await page.mouse.click(target.x + target.w / 2, target.y + target.h / 2);
      await page.waitForTimeout(1500);

      try {
        const clip = await page.evaluate(() => navigator.clipboard.readText());
        debugLog(`Clipboard after click: "${clip}" (len=${clip?.length})`);
        if (clip && clip.length >= 10 && !clip.startsWith('cli_') && clip !== appId) {
          appSecret = clip.trim();
          debugLog('Strategy A SUCCESS');
        }
      } catch (err) {
        debugLog(`Clipboard read failed: ${err.message}`);
      }
    }
  }

  // ── Strategy B: Eye icon click + network/text ──
  if (!appSecret && label) {
    debugLog('Strategy B: Eye icon click');

    const candidateSvgs = svgInfo.filter(s =>
      s.clickable &&
      s.x > label.right &&
      Math.abs(s.y - label.y) < 80
    ).sort((a, b) => a.x - b.x);

    if (candidateSvgs.length >= 2) {
      const eyeTarget = candidateSvgs[1];
      debugLog(`Clicking eye SVG[${eyeTarget.i}] at (${eyeTarget.x + eyeTarget.w/2}, ${eyeTarget.y + eyeTarget.h/2})`);

      secretFromNetwork = null;
      await page.mouse.click(eyeTarget.x + eyeTarget.w / 2, eyeTarget.y + eyeTarget.h / 2);
      await page.waitForTimeout(3000);

      if (secretFromNetwork) {
        appSecret = secretFromNetwork;
        debugLog('Strategy B SUCCESS via network');
      }

      // Dismiss dialog if any
      try {
        const cancelBtn = page.getByRole('button', { name: '取消' });
        if (await cancelBtn.count() > 0) {
          await cancelBtn.first().click();
          debugLog('Dismissed dialog');
          await page.waitForTimeout(500);
        }
      } catch {}

      if (!appSecret) {
        appSecret = await page.evaluate((currentAppId) => {
          const body = document.body.textContent || '';
          const matches = body.match(/[a-zA-Z0-9]{20,}/g);
          if (!matches) return null;
          for (const m of matches) {
            if (m === currentAppId || m.startsWith('cli_')) continue;
            if (/^[a-z]+$/i.test(m) && m.length < 25) continue;
            return m;
          }
          return null;
        }, appId);
        debugLog(`Text extraction result: ${appSecret?.substring(0, 10) || 'null'}`);
      }
    }
  }

  // ── Strategy C: JS click all candidates ──
  if (!appSecret) {
    debugLog('Strategy C: JS click');

    appSecret = await page.evaluate(async (currentAppId) => {
      const allClickable = [];
      document.querySelectorAll('*').forEach(el => {
        if (window.getComputedStyle(el).cursor === 'pointer' && el.querySelector('svg')) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.width < 50 && rect.height > 0 && rect.height < 50) {
            allClickable.push({ el, x: rect.x, y: rect.y });
          }
        }
      });

      let secretLabelY = 0;
      document.querySelectorAll('*').forEach(el => {
        if (el.textContent.trim().startsWith('App Secret') && el.textContent.length < 30) {
          secretLabelY = el.getBoundingClientRect().y;
        }
      });

      const nearby = allClickable
        .filter(b => Math.abs(b.y - secretLabelY) < 80)
        .sort((a, b) => a.x - b.x);

      if (nearby.length >= 1) {
        try { await navigator.clipboard.writeText(''); } catch {}
        nearby[0].el.click();
        await new Promise(r => setTimeout(r, 1000));
        try {
          const text = await navigator.clipboard.readText();
          if (text && text.length >= 10 && !text.startsWith('cli_') && text !== currentAppId) {
            return text;
          }
        } catch {}
      }
      return null;
    }, appId);

    debugLog(`Strategy C result: ${appSecret?.substring(0, 10) || 'null'}`);
  }

  debugLog(`Final result: ${appSecret ? 'SUCCESS' : 'FAILED'}`);

  if (!appSecret) {
    throw new Error(`无法提取 App Secret。请查看 ${DEBUG_FILE}`);
  }

  bus.sendPhase('credentials', 'done', '凭证获取成功');
  bus.sendLog(`App Secret: ${appSecret.substring(0, 6)}...`);
  return { appId, appSecret };
}

module.exports = { extractCredentials };
