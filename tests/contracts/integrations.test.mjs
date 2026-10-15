import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mcpInputValidators,
  mcpOutputValidators,
  validateNotificationEvent,
  validateNotificationReceipt,
} from '../../contracts/dist/index.js';

/** 契约夹具只表达协议元数据，不包含任何处理 URL 或真实服务凭据。 */
const event = {
  schemaVersion: 'proofrun.notification.v1',
  eventId: 'event-1',
  type: 'hitl.requested',
  occurredAt: '2026-10-15T01:00:00.000Z',
  integrationId: 'mock',
  bindingRef: 'qa',
  bindingVersion: 1,
  caseId: 'case-1',
  taskId: 'task-1',
  executionId: 'execution-1',
  arm: 'llm',
  aggregate: { kind: 'hitl', id: 'request-1', sequence: 1 },
};

// 范围：通知信封字段、事件/聚合类型和禁止任意 URL；不验证实际投递或数据库生成行为。
test('通知信封区分 case 与 HITL 聚合，拒绝处理链接', () => {
  assert.ok(validateNotificationEvent(event));
  assert.equal(
    validateNotificationEvent({
      ...event,
      url: 'https://example.test/#/hitl/secret',
    }),
    false,
  );
  assert.equal(
    validateNotificationEvent({
      ...event,
      aggregate: { ...event.aggregate, kind: 'case' },
    }),
    false,
  );
  assert.equal(
    validateNotificationEvent({ ...event, executionId: undefined }),
    false,
  );
  const { taskId, executionId, arm, ...finished } = event;
  assert.ok(
    validateNotificationEvent({
      ...finished,
      type: 'case.finished',
      aggregate: { kind: 'case', id: 'case:case-1', sequence: 1 },
    }),
  );
});

// 范围：SDK 会验证的结构化错误和单 case 参数；不证明调用已提交或未提交。
test('MCP 所有工具声明结构化错误，提交拒绝批量及任意收件人', () => {
  for (const validate of Object.values(mcpOutputValidators)) {
    assert.ok(
      validate({
        code: 'FAILED_TO_SUBMIT',
        message: '查询原身份再重试',
        retryable: true,
        effect: 'unknown',
        caseId: 'case-1',
      }),
    );
  }
  assert.equal(
    mcpInputValidators.proofrun_case_submit({ case: [], chatId: 'arbitrary' }),
    false,
  );
  assert.equal(
    mcpInputValidators.proofrun_case_get({ caseId: '../../other' }),
    false,
  );
});

// 范围：回执中的发送不确定状态与失败状态必须显式表达；不保证飞书送达或用户已阅读。
test('投递回执保留 unknown 而非伪造 delivered', () => {
  assert.ok(
    validateNotificationReceipt({
      eventId: 'event-1',
      receiptId: 'receipt-1',
      status: 'unknown',
    }),
  );
  assert.equal(
    validateNotificationReceipt({
      eventId: 'event-1',
      receiptId: 'receipt-1',
      status: 'sent-maybe',
    }),
    false,
  );
});
