import assert from 'node:assert/strict';
import test from 'node:test';
import { recoverableObservationFailure } from '../../contracts/dist/index.js';

// 范围：只豁免明确的只读 DOM 故障，其他命令与故障保持原保护；不模拟真实节点行为。
test('DOM 观察恢复条件不扩散到写入、租约或其他未知故障', () => {
  const result = {
    operationStatus: 'UNKNOWN',
    error: { code: 'DOM_ENGINE_FAILED' },
  };
  assert.equal(recoverableObservationFailure('browser.observe', result), true);
  for (const kind of [
    'browser.act',
    'browser.auth.save',
    'session.open',
    'session.renew',
  ])
    assert.equal(recoverableObservationFailure(kind, result), false);
  assert.equal(
    recoverableObservationFailure('browser.observe', {
      ...result,
      error: { code: 'NODE_RESTARTED' },
    }),
    false,
  );
  assert.equal(
    recoverableObservationFailure('browser.observe', {
      operationStatus: 'UNKNOWN',
    }),
    false,
  );
  assert.equal(
    recoverableObservationFailure('browser.observe', {
      ...result,
      operationStatus: 'SUCCEEDED',
    }),
    false,
  );
});
