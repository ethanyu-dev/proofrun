import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  validateVerificationTask,
  validateVerificationReport,
} from '../../contracts/dist/index.js';

const fixture = JSON.parse(
  readFileSync(
    new URL('../scenarios/basic-form/task.json', import.meta.url),
    'utf8',
  ),
);

// 验证范围：已有验收标准的任务样例通过结构校验；不执行 Spec 分析或浏览器任务。
test('accepts an upstream-defined task without specification analysis', () => {
  assert.equal(validateVerificationTask(fixture), true);
});

// 验证范围：空验收项和未知协议版本均被输入 Schema 拒绝。
// 不检查验收标准内容是否足以完成真实业务判定。
test('rejects an empty acceptance definition and unknown protocol', () => {
  assert.equal(
    validateVerificationTask({ ...fixture, acceptanceCriteria: [] }),
    false,
  );
  assert.equal(
    validateVerificationTask({ ...fixture, protocolVersion: '99' }),
    false,
  );
});

// 验证范围：非法 target URL 和零时长预算在执行前被拒绝。
// 不发起网络请求，也不测试运行时目标站点限制。
test('rejects unsafe input shapes before execution', () => {
  assert.equal(
    validateVerificationTask({
      ...fixture,
      target: { url: 'file:///etc/passwd' },
    }),
    false,
  );
  assert.equal(
    validateVerificationTask({
      ...fixture,
      budget: { timeoutMs: 0, maxActions: 1 },
    }),
    false,
  );
});

const blocked = {
  protocolVersion: '0.1',
  taskId: fixture.taskId,
  lifecycle: 'COMPLETED',
  executionDisposition: 'BLOCKED',
  verdict: null,
  summary: 'No eligible node is online.',
  criteria: [],
  artifacts: [],
};

// 验证范围：基础设施阻塞报告可省略产品 verdict，且不能伪装成产品失败。
// 不验证报告对应的实际任务或节点状态。
test('does not represent infrastructure blockage as a product verdict', () => {
  assert.equal(validateVerificationReport(blocked), true);
  assert.equal(
    validateVerificationReport({ ...blocked, verdict: 'FAILED' }),
    false,
  );
});

// 验证范围：确定性的验收项结论必须带证据引用。
// 不检查证据是否存在、属于本次会话或能支持该结论。
test('requires evidence references for a definite criterion verdict', () => {
  assert.equal(
    validateVerificationReport({
      ...blocked,
      executionDisposition: 'EXECUTED',
      verdict: 'PASSED',
      criteria: [
        {
          criterionId: 'order-saved',
          verdict: 'PASSED',
          summary: 'Saved.',
          evidenceRefs: [],
        },
      ],
    }),
    false,
  );
});

// 验证范围：NodeCommand Schema 拒绝 shell 透传和无字段命令上的额外属性。
// 本例只运行 TS 校验器；Rust 入口对应约束由可靠性测试单独检查。
test('node protocol rejects CLI passthrough and extra command properties', async () => {
  const { validateNodeCommand } = await import('../../contracts/dist/index.js');
  const command = {
    protocolVersion: '0.1',
    commandId: 'c',
    nodeId: 'n',
    nodeEpoch: 'e',
    sessionId: 's',
    leaseId: 'l',
    fence: 1,
    timeoutMs: 1000,
    command: { type: 'session.close' },
  };
  assert.equal(validateNodeCommand(command), true);
  assert.equal(
    validateNodeCommand({
      ...command,
      command: { type: 'session.close', args: [] },
    }),
    false,
  );
  assert.equal(
    validateNodeCommand({
      ...command,
      command: { type: 'shell', args: ['ls'] },
    }),
    false,
  );
});

// 验证范围：控制面写入复用节点操作结构，并拒绝伪造服务端会话身份。
// 这里只验证结构；worker 无权提交 session.* 由 API 的角色校验测试覆盖。
test('control requests share browser commands without accepting server-owned identity', async () => {
  const { validateControlRequest } =
    await import('../../contracts/dist/index.js');
  const request = {
    type: 'execution.command',
    commandId: 'command-1',
    timeoutMs: 1000,
    command: { type: 'browser.observe', screenshot: true },
  };
  assert.equal(validateControlRequest(request), true);
  assert.equal(
    validateControlRequest({ ...request, sessionId: 'forged' }),
    false,
  );
  assert.equal(
    validateControlRequest({
      ...request,
      command: { type: 'shell', args: [] },
    }),
    false,
  );
  assert.equal(
    validateVerificationTask({ ...fixture, taskId: '../unreachable' }),
    false,
  );
});

// 验证范围：心跳必须声明节点可接受的租约上限；不验证网络延迟和实际授权期限。
test('node heartbeat exposes bounded lease limits', async () => {
  const { validateNodeEvent } = await import('../../contracts/dist/index.js');
  const heartbeat = {
    type: 'node.heartbeat',
    protocolVersion: '0.1',
    nodeId: 'node-1',
    nodeEpoch: 'epoch-1',
    pool: 'internal',
    leaseRequestId: 'request-1',
    capacity: 1,
    occupied: [],
    capabilities: {
      observe: true,
      screenshot: true,
      writeActions: false,
      engineWritesVerified: false,
      conditionWait: true,
      networkEvidence: false,
    },
    limits: { maxLeaseMs: 60000, maxSessionMs: 3600000 },
  };
  assert.equal(validateNodeEvent(heartbeat), true);
  const { limits: _, ...missing } = heartbeat;
  assert.equal(validateNodeEvent(missing), false);
  assert.equal(
    validateNodeEvent({
      ...heartbeat,
      limits: { ...heartbeat.limits, maxLeaseMs: 0 },
    }),
    false,
  );
});

// 范围：领取协议必须给出硬截止时间，模型协议不能包含服务器身份；不核实实际租约授权。
test('执行授权与模型决定隔离服务端身份', async () => {
  const { validateExecutionGrant, validateAgentDecision } =
    await import('../../contracts/dist/index.js');
  const grant = {
    id: 'execution',
    task: fixture,
    leaseToken: 'credential',
    leaseExpiresAt: '2026-09-24T12:00:00Z',
    taskDeadlineAt: '2026-09-24T12:05:00Z',
    sessionId: 'session',
    nodeId: 'node',
    state: 'STARTING',
  };
  assert.equal(validateExecutionGrant(grant), true);
  const { taskDeadlineAt: _, ...missing } = grant;
  assert.equal(validateExecutionGrant(missing), false);
  assert.equal(
    validateAgentDecision({
      type: 'browser.act',
      action: 'click',
      target: 'element-1',
    }),
    true,
  );
  assert.equal(
    validateAgentDecision({
      type: 'browser.act',
      action: 'click',
      target: 'element-1',
      observationId: 'forged',
    }),
    false,
  );
  assert.equal(validateAgentDecision({ type: 'session.open' }), false);
});
