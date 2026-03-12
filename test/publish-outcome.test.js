const test = require('node:test');
const assert = require('node:assert/strict');

const { buildPublishOutcome } = require('../src/automation/publish');

test('buildPublishOutcome marks published releases as requiring manual available-range follow-up', () => {
  const outcome = buildPublishOutcome('published', {
    versionNumber: '1.0.250312123000',
  });

  assert.equal(outcome.status, 'published');
  assert.equal(outcome.primaryMessage, '应用已发布上线（版本 1.0.250312123000）');
  assert.equal(outcome.manualActionRequired, true);
  assert.match(outcome.manualActionMessage, /可用范围/);
  assert.match(outcome.phaseDoneMessage, /应用已发布上线/);
  assert.match(outcome.phaseDoneMessage, /可用范围/);
});

test('buildPublishOutcome keeps already-published flow distinct from the available-range follow-up', () => {
  const outcome = buildPublishOutcome('already_published');

  assert.equal(outcome.status, 'already_published');
  assert.equal(outcome.primaryMessage, '已有发布版本，跳过');
  assert.equal(outcome.manualActionRequired, true);
  assert.match(outcome.manualActionMessage, /可用范围/);
  assert.match(outcome.phaseDoneMessage, /已有发布版本/);
});
