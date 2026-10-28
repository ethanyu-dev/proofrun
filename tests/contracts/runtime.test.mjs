import assert from 'node:assert/strict';
import test from 'node:test';
import {
  validateControlRequest,
  validateRuntimeRequest,
} from '../../contracts/dist/index.js';

/** 内部启动只有非秘密执行配置；不验证模型供应商配置或真实执行效果。 */
const start = {
  type: 'start',
  config: {
    model: 'fixture',
    vision: false,
    commandMs: 1000,
    evidenceMs: 1000,
    maxTurns: 8,
    maxContextChars: 8000,
  },
};

// 范围：领取版本兼容与封闭运行时入口；不验证调度容量或真实 worker 行为。
test('运行时能力显式协商且拒绝未知版本', () => {
  const claim = { type: 'worker.claim', workerId: 'fixture' };
  assert(validateControlRequest(claim));
  assert(validateControlRequest({ ...claim, runtimeVersion: 1 }));
  assert(!validateControlRequest({ ...claim, runtimeVersion: 2 }));
  assert(validateRuntimeRequest(start));
  for (const config of [
    { ...start.config, modelKey: 'secret' },
    { ...start.config, maxTurns: 0 },
    { ...start.config, maxContextChars: Infinity },
  ])
    assert(!validateRuntimeRequest({ ...start, config }));
  assert(!validateRuntimeRequest({ ...start, report: { verdict: 'PASSED' } }));
  assert(
    !validateRuntimeRequest({
      type: 'command',
      command: { type: 'browser.act', action: 'click' },
    }),
  );
});

// 范围：决定消息绑定版本、封闭结果和有界安全反馈；不把输入通过当作账本或动作准入通过。
test('模型决定不接受无版本、混合出口或原始异常字段', () => {
  const body = {
    type: 'decision',
    revision: 1,
    outcome: {
      error: {
        code: 'INVALID_MODEL_DECISION',
        status: 0,
        message: '需要一个已声明的工具调用',
      },
    },
  };
  assert(validateRuntimeRequest(body));
  assert(!validateRuntimeRequest({ ...body, revision: 0 }));
  assert(
    !validateRuntimeRequest({ ...body, revision: Number.MAX_SAFE_INTEGER + 1 }),
  );
  assert(
    !validateRuntimeRequest({
      ...body,
      outcome: { ...body.outcome, output: {} },
    }),
  );
  assert(
    !validateRuntimeRequest({
      ...body,
      outcome: { error: { ...body.outcome.error, stack: 'raw' } },
    }),
  );
  assert(
    !validateRuntimeRequest({
      ...body,
      outcome: { error: { ...body.outcome.error, message: 'x'.repeat(4001) } },
    }),
  );
});
