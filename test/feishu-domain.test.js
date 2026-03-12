const test = require('node:test');
const assert = require('node:assert/strict');

test('selectors default to Feishu Open Platform URLs', () => {
  delete process.env.OPENCLAW_FEISHU_BASE_URL;
  const selectorsPath = require.resolve('../src/automation/selectors');
  delete require.cache[selectorsPath];
  const selectors = require(selectorsPath);

  assert.equal(selectors.urls.appList, 'https://open.feishu.cn/app');
  assert.match('https://open.feishu.cn/app', selectors.login.loggedInUrlPattern);
});

test('selectors honor OPENCLAW_FEISHU_BASE_URL for Lark deployments', () => {
  const selectorsPath = require.resolve('../src/automation/selectors');
  const previous = process.env.OPENCLAW_FEISHU_BASE_URL;
  process.env.OPENCLAW_FEISHU_BASE_URL = 'https://open.larksuite.com/';
  delete require.cache[selectorsPath];

  try {
    const selectors = require(selectorsPath);
    assert.equal(selectors.urls.appList, 'https://open.larksuite.com/app');
    assert.equal(
      selectors.urls.appBase('cli_123'),
      'https://open.larksuite.com/app/cli_123'
    );
    assert.match('https://open.larksuite.com/app', selectors.login.loggedInUrlPattern);
  } finally {
    if (previous === undefined) {
      delete process.env.OPENCLAW_FEISHU_BASE_URL;
    } else {
      process.env.OPENCLAW_FEISHU_BASE_URL = previous;
    }
    delete require.cache[selectorsPath];
  }
});
