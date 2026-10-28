import test from 'node:test';
import assert from 'node:assert/strict';
import type { DecisionInput } from '@proofrun/execution-core/model';
import { ExternalEngine } from '../src/modules/external-execution/engine.js';
import { DecisionWindow } from '../src/modules/external-execution/decision-window.js';

// 范围：可控单调时钟验证双期限和过期边界；不模拟 PostgreSQL、浏览器或生产耗时。
test('外部窗口持续扣时并保留原收尾时间，读取不能重新续期', () => {
  const input = {
    context: { budget: { timeMs: 300000 } },
    modelDeadline: 241000,
  } as DecisionInput;
  const window = new DecisionWindow(input, 1000, 1700000000000);
  const first = window.view(1000),
    later = window.view(61000);
  assert.equal(first.timeMs, 300000);
  assert.equal(first.decisionTimeMs, 240000);
  assert.equal(later.timeMs, 240000);
  assert.equal(later.decisionTimeMs, 180000);
  assert.equal(first.stepDeadlineAt, later.stepDeadlineAt);
  assert.equal(first.decisionDeadlineAt, later.decisionDeadlineAt);
  assert.equal(window.view(241000).decisionTimeMs, 0);
  assert.equal(window.view(241000).timeMs, 60000);
  assert.equal(window.view(400000).timeMs, 0);
});

// 范围：准备阶段缺少模型期限时与硬期限一致；迟到的模型期限不能扩大步骤授权。
test('无预留或迟到窗口都不能超出原步骤预算', () => {
  const input = { context: { budget: { timeMs: 100 } } } as DecisionInput;
  assert.equal(
    new DecisionWindow(input, 500, 1000).view(550).decisionTimeMs,
    50,
  );
  input.modelDeadline = 10000;
  assert.equal(new DecisionWindow(input, 500, 1000).decisionDeadline, 600);
  input.modelDeadline = 400;
  assert.equal(
    new DecisionWindow(input, 500, 1000).view(500).decisionTimeMs,
    0,
  );
});

// 范围：模拟持久登记与进程内唤醒之间切帧的竞态；不模拟数据库提交或真实浏览器效果。
test('唤醒必须仍是原版本且窗口有效，过期决定不能送到下一帧', () => {
  const engine = new ExternalEngine(
    null as never,
    null as never,
    'http://fixture.test',
  );
  const input = { context: { budget: { timeMs: 60000 } } } as DecisionInput;
  let delivered = 0;
  const current = {
    ready: true,
    operationId: undefined as string | undefined,
    pending: {
      window: new DecisionWindow(input),
      revision: 8,
      resolve: () => {
        delivered++;
      },
    },
  };
  // 只装配内部等待状态，以便确定性覆盖事务间隙，不给生产接口增加测试时钟或越权参数。
  Reflect.get(engine, 'active').set('controller', current);
  const decision = { type: 'browser.observe' } as const;
  assert.equal(engine.timing('controller', 7), undefined);
  assert.equal(engine.timing('controller', 8)?.decisionTimeMs! > 0, true);
  assert.throws(() => engine.accept('controller', 'old', decision, 7), {
    code: 'REVISION_CONFLICT',
  });
  current.ready = false;
  assert.throws(() => engine.accept('controller', 'unpublished', decision, 8), {
    code: 'REVISION_CONFLICT',
  });
  current.ready = true;
  current.pending.window = new DecisionWindow({
    ...input,
    modelDeadline: performance.now() - 1,
  });
  assert.throws(() => engine.accept('controller', 'expired', decision, 8), {
    code: 'REVISION_CONFLICT',
  });
  assert.equal(delivered, 0);
  assert.equal(current.operationId, undefined);
  current.pending.window = new DecisionWindow(input);
  engine.accept('controller', 'valid', decision, 8);
  assert.equal(delivered, 1);
  assert.equal(current.operationId, 'valid');
  assert.throws(() => engine.accept('controller', 'duplicate', decision, 8), {
    code: 'EXECUTION_RUNTIME_LOST',
  });
});
