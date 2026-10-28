import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  executionMcpTools,
  executionMcpCatalog,
  validateExecutionMcpArguments,
  externalExecutionRequestSchema,
  validateExternalExecutionRequest,
} from '../../contracts/dist/index.js';
const require = createRequire(
  new URL('../../contracts/package.json', import.meta.url),
);
const { Ajv } = require('ajv');
const formats = require('ajv-formats');
const base = {
  controllerId: randomUUID(),
  operationId: randomUUID(),
  expectedRevision: 1,
  observationId: 'current',
  stepId: 'check',
};
// 范围：所有发现契约离线可编译且拒绝未知参数；不证明领域权限、节点能力或真实执行。
test('操作工具从底层契约派生，输入输出自包含且按决定收窄', () => {
  const ajv = new Ajv({ strict: true });
  formats(ajv);
  assert.equal(executionMcpTools.length, 17);
  assert.equal(new Set(executionMcpTools.map((t) => t.name)).size, 17);
  for (const tool of executionMcpTools) {
    assert.ok(!JSON.stringify(tool).includes('$ref'), tool.name);
    const validate = ajv.compile(tool.inputSchema);
    const output = ajv.compile(tool.outputSchema);
    assert.ok(
      output({ code: 'SCOPE_FORBIDDEN', message: '未授权', retryable: false }),
    );
    const entry = executionMcpCatalog.find((t) => t.name === tool.name);
    if (entry.decisionType) {
      assert.equal(
        tool.inputSchema.properties.decision.properties.type.const,
        entry.decisionType,
      );
      assert.equal(
        validate({
          ...base,
          decision: { type: 'verification.environment', mode: 'guest' },
        }),
        false,
      );
      assert.equal(
        validate({
          ...base,
          decision: { type: entry.decisionType },
          leaseToken: 'raw',
        }),
        false,
      );
      assert.equal(
        tool.inputSchema.properties.expectedRevision.maximum,
        externalExecutionRequestSchema.oneOf.at(-1).properties.expectedRevision
          .maximum,
      );
    }
  }
  const observe = {
    ...base,
    decision: { type: 'browser.observe', screenshot: false },
  };
  assert.ok(validateExecutionMcpArguments.get('browser_observe')(observe));
  const { controllerId, ...request } = observe;
  assert.ok(validateExternalExecutionRequest({ ...request, type: 'decide' }));
  for (const change of [
    { controllerId: 'not-uuid' },
    { expectedRevision: 0 },
    { report: {} },
    { decision: { type: 'browser.act', action: 'click' } },
    { decision: { type: 'browser.observe', script: 'return 1' } },
  ])
    assert.equal(
      validateExecutionMcpArguments.get('browser_observe')({
        ...observe,
        ...change,
      }),
      false,
    );
  const finish = {
    ...base,
    decision: { type: 'verification.finish', summary: '完成', progress: {} },
  };
  assert.ok(
    validateExecutionMcpArguments.get('verification_finish_step')(finish),
  );
  const { stepId, ...missing } = finish;
  assert.equal(
    validateExecutionMcpArguments.get('verification_finish_step')(missing),
    false,
  );
});
