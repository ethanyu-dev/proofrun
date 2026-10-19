import assert from 'node:assert/strict';
import test from 'node:test';
import {
  executionOutcome,
  validateNodeEvent,
} from '../../contracts/dist/index.js';

// 范围：只验证原因分类和优先级，不模拟人工操作、数据库超时扫描或真实节点关闭。
test('环境阻塞保留根因，人工超时必须有明确终止码', () => {
  const facts = {
    state: 'ERROR',
    code: 'SESSION_ENDED',
    controlMode: 'HUMAN',
    blockingCode: 'ENVIRONMENT_NOT_READY',
    blockingReason: '缺少子账号',
  };
  assert.equal(executionOutcome(facts).category, 'ENVIRONMENT_BLOCKED');
  assert.equal(executionOutcome(facts).terminationCode, 'SESSION_ENDED');
  assert.equal(
    executionOutcome({
      ...facts,
      code: 'HUMAN_INTERVENTION_TIMEOUT',
      state: 'TIMED_OUT',
    }).category,
    'HUMAN_TIMEOUT',
  );
  assert.equal(
    executionOutcome({ ...facts, controlMode: 'AUTO' }).category,
    'SESSION_ERROR',
  );
  assert.equal(
    executionOutcome({ ...facts, blockingCode: 'GENERAL' }).category,
    'SESSION_ERROR',
  );
  assert.equal(
    executionOutcome({ ...facts, state: 'CANCELLED' }).category,
    'CANCELLED',
  );
  assert.equal(
    executionOutcome({ ...facts, state: 'RUNNING' }).category,
    'WAITING_HUMAN',
  );
});

// 范围：原因码来自报告或控制面；不把验收失败当作平台错误，也不以自然语言推断根因。
test('运行、预算、资源、模型和未知异常有独立分类', () => {
  const cases = {
    TASK_QUEUE_TIMEOUT: 'QUEUE_TIMEOUT',
    STEP_ACTION_BUDGET_EXCEEDED: 'BUDGET_EXHAUSTED',
    WORKER_LEASE_EXPIRED: 'WORKER_ERROR',
    NODE_SHUTDOWN: 'NODE_ERROR',
    SESSION_LEASE_EXPIRED: 'SESSION_ERROR',
    MODEL_REQUEST_FAILED: 'MODEL_ERROR',
    MODEL_BLOCKED: 'EXECUTION_BLOCKED',
    INVALID_MODEL_DECISION: 'MODEL_ERROR',
    TRANSPORT_ERROR: 'SERVICE_ERROR',
    HTTP_ERROR: 'SERVICE_ERROR',
    BROWSER_ACTION_PRECONDITION_FAILED: 'BROWSER_ERROR',
    CLEANUP_PENDING: 'CLEANUP_ERROR',
    NO_PROGRESS: 'EXECUTION_BLOCKED',
    UNRECOGNIZED: 'EXECUTION_ERROR',
  };
  for (const [code, category] of Object.entries(cases))
    assert.equal(executionOutcome({ state: 'ERROR', code }).category, category);
  assert.equal(
    executionOutcome({ state: 'COMPLETED', disposition: 'EXECUTED' }).category,
    'COMPLETED',
  );
  assert.equal(
    executionOutcome({
      state: 'COMPLETED',
      disposition: 'BLOCKED',
      reportCode: 'ENVIRONMENT_NOT_READY',
    }).category,
    'ENVIRONMENT_BLOCKED',
  );
});

// 范围：正常阻塞与旧 AGENT_ERROR 包装均保留原因码；不覆盖真实模型服务或浏览器执行。
test('MODEL_BLOCKED 属于执行受阻，独立终止原因仍有优先级', () => {
  for (const facts of [
    { state: 'COMPLETED', reportCode: 'MODEL_BLOCKED', disposition: 'BLOCKED' },
    { state: 'ERROR', code: 'AGENT_ERROR', reportCode: 'MODEL_BLOCKED' },
  ]) {
    const outcome = executionOutcome(facts);
    assert.equal(outcome.category, 'EXECUTION_BLOCKED');
    assert.equal(outcome.reasonCode, 'MODEL_BLOCKED');
  }
  assert.equal(
    executionOutcome({
      state: 'TIMED_OUT',
      code: 'HUMAN_INTERVENTION_TIMEOUT',
      reportCode: 'MODEL_BLOCKED',
    }).category,
    'HUMAN_TIMEOUT',
  );
});

// 范围：新旧节点关闭事件兼容与封闭枚举；实际关闭来源由 Rust 监管器提供。
test('关闭原因可选且不接受任意字符串', () => {
  const event = {
    type: 'session.closed',
    messageId: 'event',
    sessionId: 'session',
    nodeEpoch: 'epoch',
    leaseId: 'lease',
    fence: 1,
    state: 'CLOSED',
    closureVerified: true,
  };
  assert.ok(validateNodeEvent(event));
  for (const closeReason of [
    'NODE_SHUTDOWN',
    'NODE_RESTART_RECOVERY',
    'SESSION_LEASE_EXPIRED',
    'HOST_EXITED',
    'HOST_CHANNEL_CLOSED',
    'UNKNOWN',
  ])
    assert.ok(validateNodeEvent({ ...event, closeReason }));
  assert.equal(
    validateNodeEvent({ ...event, closeReason: 'guessed reason' }),
    false,
  );
});

// 范围：兼容旧控制面统一收口的错误，不覆盖独立会话终止码或推断错误文案。
test('AGENT_ERROR 下优先用报告的具体故障分类', () => {
  const facts = {
    state: 'ERROR',
    code: 'AGENT_ERROR',
    reportCode: 'INVALID_MODEL_DECISION',
    disposition: 'ERROR',
  };
  assert.equal(executionOutcome(facts).category, 'MODEL_ERROR');
  assert.equal(executionOutcome(facts).reasonCode, 'INVALID_MODEL_DECISION');
  assert.equal(executionOutcome(facts).terminationCode, 'AGENT_ERROR');
  assert.equal(
    executionOutcome({ ...facts, code: 'SESSION_ENDED' }).category,
    'SESSION_ERROR',
  );
});
