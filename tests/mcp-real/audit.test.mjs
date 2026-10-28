import assert from 'node:assert/strict';
import test from 'node:test';
import { transcriptFacts, verifyAudit } from './audit.mjs';

/** 只构造审核输入，不把此合成结果当成真实模型或浏览器验收。 */
function validAudit() {
  const tools = [
    'browser_get_capabilities',
    'verification_get_capabilities',
    'verification_validate_cases',
    'verification_submit_cases',
    'verification_bind_run',
    'browser_act',
    'verification_record',
    'verification_finish_step',
    'verification_get_run',
    'verification_get_request',
  ];
  return {
    exitCode: 0,
    transcript: {
      completed: true,
      outsideCalls: [],
      tools,
      calls: tools.map((tool) => ({
        tool,
        server: tool.startsWith('browser_')
          ? 'proofrun_browser'
          : 'proofrun_verification',
        arguments: {},
      })),
      phases: ['PREPARING', 'CHECKING', 'VERIFYING', 'CLEANUP'],
      deliveredImage: true,
      readClosed: true,
    },
    tasks: [
      {
        state: 'COMPLETED',
        report: {
          verdict: 'PASSED',
          executor: { kind: 'external' },
          criteria: [
            {
              criterionId: 'verify-expected-1',
              verdict: 'PASSED',
              evidenceRefs: ['fixture-evidence'],
            },
          ],
        },
        step_results: ['prepare', 'verify', 'cleanup'].map((stepId) => ({
          stepId,
          status: 'COMPLETED',
        })),
      },
    ],
    executions: [{ closure_verified: true }],
    site: {
      records: [],
      writes: [
        { method: 'POST', name: 'MCP-REAL-001' },
        { method: 'DELETE', count: 1 },
      ],
    },
    modelCalls: 0,
  };
}

// 范围：审核器不能仅凭 PASSED 接受缺失阶段、重复业务写入或未物理关闭；不执行浏览器。
test('真实联调审核同时要求调用链、独立副作用和关闭事实', () => {
  verifyAudit(validAudit(), {});
  for (const mutate of [
    (a) => a.transcript.phases.splice(1, 1),
    (a) => a.transcript.outsideCalls.push('command_execution'),
    (a) => (a.transcript.calls[0].server = 'unrelated_browser'),
    (a) => (a.transcript.deliveredImage = false),
    (a) => (a.transcript.readClosed = false),
    (a) => a.site.writes.unshift({ method: 'POST', name: 'MCP-REAL-001' }),
    (a) => a.site.records.push('MCP-REAL-001'),
    (a) => (a.tasks[0].step_results[2].status = 'SKIPPED'),
    (a) => (a.tasks[0].report.executor.kind = 'builtin'),
    (a) => (a.tasks[0].report.criteria[0].verdict = 'INCONCLUSIVE'),
    (a) => (a.tasks[0].report.criteria[0].evidenceRefs = []),
    (a) => (a.executions[0].closure_verified = false),
    (a) => (a.modelCalls = 1),
  ]) {
    const audit = validAudit();
    mutate(audit);
    assert.throws(() => verifyAudit(audit, {}));
  }
  assert.throws(() => verifyAudit(validAudit(), { cases: ['altered'] }));
});

// 范围：解析实际 CLI 事件形状，批准拒绝和 MCP 领域错误不能计为成功；不发真实模型请求。
test('事件解析保留审批失败和领域错误，不用最终文字冒充成功', () => {
  const item = {
    type: 'mcp_tool_call',
    server: 'proofrun_verification',
    tool: 'verification_submit_cases',
    arguments: {},
  };
  const text = [
    'diagnostic line',
    JSON.stringify({
      type: 'item.completed',
      item: { ...item, error: { message: 'requires approval' }, result: null },
    }),
    JSON.stringify({
      type: 'item.completed',
      item: {
        ...item,
        error: null,
        result: {
          is_error: true,
          structured_content: { code: 'SCOPE_FORBIDDEN' },
        },
      },
    }),
    JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: '全部 PASSED' },
    }),
    JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 100, output_tokens: 10 },
    }),
  ].join('\n');
  const facts = transcriptFacts(text);
  assert.equal(facts.calls.length, 2);
  assert.deepEqual(facts.tools, []);
  assert.equal(facts.deliveredImage, false);
  assert.equal(facts.readClosed, false);
  assert.deepEqual(facts.usage, { input_tokens: 100, output_tokens: 10 });
});
