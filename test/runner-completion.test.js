const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSuccessDoneMessage } = require('../src/automation/runner');

test('buildSuccessDoneMessage appends publish manual action guidance for feishu full runs', () => {
  const message = buildSuccessDoneMessage(
    {
      completionMessage: '所有步骤已完成！飞书机器人已配置、发布，并已主动给当前操作者发送首条消息。',
    },
    {
      publishManualActionRequired: true,
      publishManualActionMessage: '若需让其他成员在 Feishu / Lark 中搜到机器人，仍需到“版本管理与发布 → 可用范围”手动添加人员或部门并重新发布。',
    }
  );

  assert.match(message, /所有步骤已完成/);
  assert.match(message, /可用范围/);
});

test('buildSuccessDoneMessage keeps the original completion text when no manual follow-up is required', () => {
  const message = buildSuccessDoneMessage(
    {
      completionMessage: '企业微信机器人已创建并接入 OpenClaw，Gateway 已完成重启并建立长连接。',
    },
    {
      publishManualActionRequired: false,
      publishManualActionMessage: '',
    }
  );

  assert.equal(message, '企业微信机器人已创建并接入 OpenClaw，Gateway 已完成重启并建立长连接。');
});
