const S = require('./selectors');
const { dismissModals } = require('./dismiss-modals');
const fs = require('fs');
const path = require('path');
const { LOG_DIR } = require('../utils/paths');
const REQUIRED_SCOPES = Array.from(new Set(S.permissions.requiredScopes));
const PERMISSION_IMPORT_JSON = JSON.stringify(S.permissions.importPayload, null, 2);
const ENABLE_UNSAFE_SCOPE_FALLBACK = process.env.FEISHU_PERMISSION_UNSAFE_FALLBACK === '1';

async function configurePermissions(page, bus, appId) {
  bus.sendPhase('permissions', 'running', '正在配置权限...');

  await page.goto(S.urls.credentials(appId), { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);
  await dismissModals(page, bus);
  await page.waitForTimeout(1000);

  // Click "权限管理" in sidebar
  bus.sendLog('点击侧边栏"权限管理"...');
  const permLink = page.locator(`text=${S.sidebar.permissions}`).first();
  const [newPage] = await Promise.all([
    page.context().waitForEvent('page', { timeout: 5000 }).catch(() => null),
    permLink.click(),
  ]);

  let workPage = page;
  if (newPage) {
    await newPage.waitForLoadState('domcontentloaded');
    await newPage.waitForTimeout(3000);
    workPage = newPage;
  } else {
    await page.waitForTimeout(3000);
  }

  await dismissModals(workPage, bus);
  await workPage.waitForTimeout(1000);

  fs.mkdirSync(LOG_DIR, { recursive: true });

  let verifiedCount = 0;
  try {
    verifiedCount = await tryBatchImport(workPage, bus);
  } catch (err) {
    if (!ENABLE_UNSAFE_SCOPE_FALLBACK) {
      throw err;
    }
    bus.sendLog(`批量导入失败，启用不安全兜底逻辑: ${err.message}`);
    verifiedCount = await selectScopesIndividually(workPage, bus);
  }

  try {
    await workPage.screenshot({
      path: path.join(LOG_DIR, 'permissions-done.png'),
      fullPage: true,
    });
  } catch {}

  await dismissModals(workPage, bus);
  await workPage.waitForTimeout(2000);

  if (newPage) await newPage.close();
  bus.sendPhase('permissions', 'done', `权限配置完成（验证到 ${verifiedCount} 项）`);
}

async function tryBatchImport(page, bus) {
  bus.sendLog('优先尝试通过“批量导入”一次性配置权限...');

  const batchOpened = await openImportDialog(page);
  if (!batchOpened) {
    throw new Error('未找到“批量导入”入口');
  }

  const editorReady = await waitForImportEditor(page);
  if (!editorReady) {
    throw new Error('批量导入编辑器未找到');
  }

  await replaceImportJson(page, PERMISSION_IMPORT_JSON);
  await assertImportedJson(page);

  if (!(await clickExactButton(page, ['下一步，确认新增权限']))) {
    throw new Error('批量导入下一步按钮未找到');
  }

  await page.waitForTimeout(2500);
  if (!(await clickExactButton(page, ['申请开通']))) {
    throw new Error('批量导入申请开通按钮未找到');
  }
  await page.waitForTimeout(3000);

  await clickAnyButton(page, ['我知道了', '确认', '确定']);
  await page.waitForTimeout(1500);

  const modalStillVisible = await page.getByRole('button', { name: '申请开通', exact: true }).isVisible().catch(() => false);
  if (modalStillVisible) {
    throw new Error('批量导入弹窗仍未关闭，权限申请状态不明确');
  }

  await closePostImportDrawer(page);
  const verifiedCount = await verifyImportedScopes(page, bus);
  if (verifiedCount < REQUIRED_SCOPES.length) {
    throw new Error(`权限导入校验失败，仅检测到 ${verifiedCount}/${REQUIRED_SCOPES.length} 个目标 scope`);
  }

  return verifiedCount;
}

async function openImportDialog(page) {
  if (await clickExactButton(page, ['批量导入/导出权限'])) {
    await page.waitForTimeout(1500);
    return true;
  }

  if (await clickAnyButton(page, [S.permissions.grantButton])) {
    await page.waitForTimeout(1500);
    if (await clickExactButton(page, ['批量导入/导出权限'])) {
      await page.waitForTimeout(1500);
      return true;
    }
  }

  return false;
}

async function selectScopesIndividually(page, bus) {
  if (!(await clickAnyButton(page, [S.permissions.grantButton]))) {
    throw new Error('"开通权限"按钮未找到');
  }
  await page.waitForTimeout(2000);

  const allInputs = page.locator('input:visible');
  for (let i = 0; i < await allInputs.count(); i++) {
    const inp = allInputs.nth(i);
    const placeholder = await inp.getAttribute('placeholder') || '';
    if (placeholder.includes('例如') || placeholder.includes('im:') || placeholder.includes('获取')) {
      bus.sendLog(`找到搜索框: "${placeholder}"`);
      for (const scope of REQUIRED_SCOPES) {
        await inp.fill('');
        await page.waitForTimeout(300);
        await inp.fill(scope);
        await page.waitForTimeout(1200);
        await selectScopeCheckbox(page, scope);
      }

      await inp.fill('');
      await page.waitForTimeout(500);
      await clickAnyButton(page, ['确认开通权限', '确认', '确定']);
      await page.waitForTimeout(2500);
      return countVerifiedScopes(page);
    }
  }

  throw new Error('权限搜索框未找到');
}

async function selectScopeCheckbox(page, scope) {
  await page.evaluate((targetScope) => {
    const allElements = Array.from(document.querySelectorAll('*'));
    for (const el of allElements) {
      const text = el.textContent.trim();
      if (!text.includes(targetScope) || text.length > 200 || !el.offsetParent) {
        continue;
      }

      let node = el;
      for (let depth = 0; depth < 8 && node; depth++) {
        const checkbox = node.querySelector('input[type="checkbox"], [role="checkbox"]');
        if (checkbox) {
          if (checkbox.getAttribute('role') === 'checkbox' && checkbox.getAttribute('aria-checked') !== 'true') {
            checkbox.click();
            return;
          }

          if (checkbox.tagName === 'INPUT' && !checkbox.checked) {
            checkbox.click();
            return;
          }
        }
        node = node.parentElement;
      }
    }
  }, scope);
}

async function clickAnyButton(page, labels) {
  for (const label of labels) {
    const button = page.getByRole('button', { name: label, exact: false });
    if (await button.count()) {
      const first = button.first();
      if (await first.isVisible()) {
        try {
          await first.click();
        } catch {
          await first.click({ force: true });
        }
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

async function clickExactButton(page, labels) {
  for (const label of labels) {
    const button = page.getByRole('button', { name: label, exact: true });
    if (await button.count()) {
      const first = button.first();
      if (await first.isVisible()) {
        try {
          await first.click();
        } catch {
          await first.click({ force: true });
        }
        return true;
      }
    }
  }

  return false;
}

async function countVerifiedScopes(page) {
  const bodyText = await page.evaluate(() => document.body.innerText || '');
  return REQUIRED_SCOPES.reduce((count, scope) => {
    return bodyText.includes(scope) ? count + 1 : count;
  }, 0);
}

async function findImportEditor(page) {
  const text = await readImportEditorText(page);
  return typeof text === 'string' && text.length > 0;
}

async function waitForImportEditor(page, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const editor = await findImportEditor(page);
    if (editor) {
      return editor;
    }
    await page.waitForTimeout(500);
  }
  return null;
}

async function replaceImportJson(page, nextValue, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await page.evaluate((value) => {
      const activePane = Array.from(document.querySelectorAll('.ud__tabs__pane'))
        .find((pane) => !pane.classList.contains('ud__tabs__pane--inactive') && pane.querySelector('.common-monaco'));
      const host = activePane?.querySelector('.common-monaco');
      if (!host) {
        return { ok: false, reason: 'host-not-found' };
      }

      const fiberKey = Object.getOwnPropertyNames(host).find((key) => key.startsWith('__reactFiber'));
      if (!fiberKey) {
        return { ok: false, reason: 'fiber-not-found' };
      }

      const called = [];
      const invoked = new Set();
      let fiber = host[fiberKey];
      while (fiber) {
        const props = fiber.memoizedProps || {};
        const candidates = [
          [
            'setValue',
            props.setValue,
            typeof props.value === 'string' && Object.prototype.hasOwnProperty.call(props, 'activeTab'),
          ],
          [
            'onChange',
            props.onChange,
            typeof props.value === 'string' && typeof props.language === 'string',
          ],
        ];

        for (const [name, fn, shouldCall] of candidates) {
          if (!shouldCall || typeof fn !== 'function' || invoked.has(fn)) {
            continue;
          }

          try {
            fn(value);
            invoked.add(fn);
            called.push(name);
          } catch {}
        }
        fiber = fiber.return;
      }

      return { ok: called.length > 0, called };
    }, nextValue);

    if (!result.ok) {
      await page.waitForTimeout(300);
      continue;
    }

    try {
      await waitForImportedJson(page, 4000);
      return;
    } catch {
      await page.waitForTimeout(300);
    }
  }

  throw new Error('批量导入内容写入失败');
}

async function readImportEditorText(page) {
  return page.evaluate(() => {
    const activePane = Array.from(document.querySelectorAll('.ud__tabs__pane'))
      .find((pane) => !pane.classList.contains('ud__tabs__pane--inactive') && pane.querySelector('.common-monaco'));
    const editor = activePane?.querySelector('.monaco-editor:not(.common-monaco-editor--readOnly)')
      || activePane?.querySelector('.monaco-editor');
    if (!editor) {
      return null;
    }

    const lines = Array.from(editor.querySelectorAll('.view-line'))
      .map((line) => (line.textContent || '').replace(/\u00a0/g, ' '));
    return lines.join('\n');
  });
}

function parseImportedJson(text) {
  const imported = JSON.parse(text);
  const requiredTenantScopes = Array.from(new Set(REQUIRED_SCOPES)).sort();
  const actualTenantScopes = Array.isArray(imported?.scopes?.tenant)
    ? imported.scopes.tenant.map(String).sort()
    : [];

  const missing = requiredTenantScopes.filter((scope) => !actualTenantScopes.includes(scope));
  if (missing.length > 0) {
    throw new Error(`批量导入编辑器内容异常，缺少 scope: ${missing.join(', ')}`);
  }

  return imported;
}

async function waitForImportedJson(page, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let lastText = null;
  while (Date.now() < deadline) {
    const text = await readImportEditorText(page);
    if (text) {
      lastText = text;
      try {
        parseImportedJson(text);
        return text;
      } catch {}
    }
    await page.waitForTimeout(250);
  }

  if (!lastText) {
    throw new Error('批量导入编辑器内容为空');
  }

  throw new Error(`批量导入编辑器内容异常: ${lastText}`);
}

async function assertImportedJson(page) {
  const currentValue = await waitForImportedJson(page);
  parseImportedJson(currentValue);
}

async function closePostImportDrawer(page) {
  const drawerVisible = await page.getByText('可访问的数据范围', { exact: false }).isVisible().catch(() => false);
  if (!drawerVisible) {
    return;
  }

  if (await clickExactButton(page, ['确认'])) {
    await page.waitForTimeout(1500);
    return;
  }

  if (await clickExactButton(page, ['确定'])) {
    await page.waitForTimeout(1500);
    return;
  }

  const closeButton = page.locator('.ud-drawer button, .ud__drawer button').filter({ has: page.locator('svg') }).last();
  if (await closeButton.isVisible().catch(() => false)) {
    await closeButton.click({ force: true }).catch(() => {});
    await page.waitForTimeout(1000);
  }
}

async function verifyImportedScopes(page, bus) {
  await closePostImportDrawer(page);
  await page.waitForTimeout(1000);

  const pageVerifiedCount = await countVerifiedScopes(page);
  if (pageVerifiedCount >= REQUIRED_SCOPES.length) {
    return pageVerifiedCount;
  }

  const reopened = await openImportDialog(page);
  if (!reopened) {
    bus.sendLog('导入完成后无法重新打开批量导入弹窗，退回页面文本校验');
    return countVerifiedScopes(page);
  }

  const editorReady = await waitForImportEditor(page);
  if (!editorReady) {
    throw new Error('导入完成后无法读取批量导入编辑器');
  }

  const exportedValue = await readImportEditorText(page);
  if (!exportedValue) {
    throw new Error('导入完成后无法读取批量导入编辑器');
  }
  const exported = JSON.parse(exportedValue);
  const tenantScopes = Array.isArray(exported?.scopes?.tenant)
    ? exported.scopes.tenant.map(String)
    : [];
  const verifiedCount = REQUIRED_SCOPES.reduce((count, scope) => {
    return tenantScopes.includes(scope) ? count + 1 : count;
  }, 0);

  await clickExactButton(page, ['取消']);
  await page.waitForTimeout(500);

  return verifiedCount;
}

module.exports = { configurePermissions };
