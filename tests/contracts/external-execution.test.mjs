import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  validateExternalExecutionRequest,
  validateExternalExecutionResult,
  validateMcpTaskCall,
} from '../../contracts/dist/index.js';

// 范围：公开协议严格拒绝原始执行材料和报告；不验证主体归属或实际派发。
test('外部决定信封绑定版本和观察，不接受内部控制命令', () => {
  const input = {
    type: 'decide',
    operationId: randomUUID(),
    expectedRevision: 1,
    observationId: 'current',
    stepId: 'check',
    decision: { type: 'browser.observe' },
  };
  assert.ok(validateExternalExecutionRequest(input));
  for (const change of [
    { expectedRevision: 0 },
    { expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
    { operationId: 'retry-key' },
    { report: { verdict: 'PASSED' } },
    { leaseToken: 'private' },
    { decision: { type: 'browser.act', action: 'javascript', script: '1' } },
    {
      decision: {
        type: 'verification.finish',
        summary: '伪造',
        verdict: 'PASSED',
      },
    },
  ])
    assert.equal(
      validateExternalExecutionRequest({ ...input, ...change }),
      false,
      JSON.stringify(change),
    );
  assert.ok(
    validateExternalExecutionRequest({
      type: 'open',
      operationId: randomUUID(),
      taskKey: 'sample',
      url: 'https://example.test',
      objective: '观察页面',
    }),
  );
  assert.ok(
    validateMcpTaskCall({
      name: 'verification_get_capabilities',
      arguments: { executor: { kind: 'external' } },
    }),
  );
});

// 范围：操作回执的处理状态与进度/效果独立；不把回执当作业务验收。
test('外部回执不泄漏内部字段，失败仍可声明进度已保存', () => {
  const result = {
    kind: 'operation',
    data: {
      operationId: randomUUID(),
      controllerId: 'binding',
      runId: 'run',
      status: 'FAILED',
      progressApplied: true,
      effect: 'NOT_STARTED',
      error: { code: 'INVALID_TARGET' },
    },
  };
  assert.ok(validateExternalExecutionResult(result));
  assert.equal(
    validateExternalExecutionResult({
      ...result,
      data: { ...result.data, leaseToken: 'private' },
    }),
    false,
  );
  assert.equal(
    validateExternalExecutionResult({
      ...result,
      data: { ...result.data, status: 'PASSED' },
    }),
    false,
  );
});

// 范围：生成 OpenAPI 的所有本地引用可解析，避免 HTTP 客户端发现残留内部 $ref；不验证网络传输。
test('外部执行 OpenAPI 包含严格输入和可解析的决定引用', () => {
  const api = JSON.parse(
    readFileSync(
      new URL('../../contracts/public-api.openapi.json', import.meta.url),
    ),
  );
  assert.ok(api.paths['/v3/browser/sessions'].post);
  assert.ok(api.paths['/v3/controllers/{id}/steps/{stepId}/progress'].post);
  assert.ok(
    !api.paths['/v3/controllers/{id}/decisions'].post.requestBody.content[
      'application/json'
    ].schema.properties.type,
  );
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (key === '$ref') {
        assert.ok(item.startsWith('#/'), item);
        let current = api;
        for (const part of item.slice(2).split('/'))
          current = current?.[part.replaceAll('~1', '/').replaceAll('~0', '~')];
        assert.ok(current, item);
      } else visit(item);
    }
  };
  visit(api);
});
