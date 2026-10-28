import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createRequire } from 'node:module';
import {
  taskMcpTools,
  taskMcpOutputSchema,
  validateMcpTaskCall,
  validateMcpTaskResult,
} from '../../contracts/dist/index.js';
const require = createRequire(
  new URL('../../contracts/package.json', import.meta.url),
);
const { Ajv } = require('ajv');
const formats = require('ajv-formats');

// 范围：离线发现 Schema 自包含、权限边界参数及错误返回结构；不覆盖网络协议或真实执行。
test('任务 MCP 输入输出来自单一契约且可独立编译', () => {
  const ajv = new Ajv({ strict: true });
  formats(ajv);
  assert.equal(taskMcpTools.length, 15);
  for (const tool of taskMcpTools) {
    assert.ok(!JSON.stringify(tool.inputSchema).includes('$ref'));
    ajv.compile(tool.inputSchema);
  }
  const output = ajv.compile(taskMcpOutputSchema);
  assert.equal(
    output({ code: 'SCOPE_FORBIDDEN', message: '拒绝', retryable: false }),
    true,
  );
  assert.equal(
    validateMcpTaskResult({
      code: 'SCOPE_FORBIDDEN',
      message: '拒绝',
      retryable: false,
    }),
    false,
  );
  assert.equal(
    validateMcpTaskCall({
      name: 'browser_task_submit',
      arguments: {
        taskKey: 'example',
        url: 'https://example.test',
        objective: '读取标题',
      },
    }),
    true,
  );
  for (const extra of [
    { session: { mode: 'guest' } },
    { principalId: 'other' },
    { executor: { kind: 'external' } },
    { environment: { nodePool: 'private' } },
  ]) {
    assert.equal(
      validateMcpTaskCall({
        name: 'browser_task_submit',
        arguments: {
          taskKey: 'example',
          url: 'https://example.test',
          objective: '读取标题',
          ...extra,
        },
      }),
      false,
    );
  }
  assert.equal(
    validateMcpTaskCall({
      name: 'browser_task_submit',
      arguments: {
        taskKey: 'example',
        url: 'file:///etc/passwd',
        objective: '读取',
      },
    }),
    false,
  );
  assert.equal(
    validateMcpTaskCall({
      name: 'verification_get_run',
      arguments: { runId: 'example', limit: 101 },
    }),
    false,
  );
});

// 范围：生成的 HTTP 字段与 MCP Schema 一致、v3 认证独立；不证明部署已启用或工具获授权。
test('公共 OpenAPI 的 v3 提交参数直接复用 MCP 输入', () => {
  const doc = JSON.parse(
    readFileSync(
      new URL('../../contracts/public-api.openapi.json', import.meta.url),
      'utf8',
    ),
  );
  const operation = doc.paths['/v3/browser/tasks'].post;
  assert.deepEqual(operation.security, [{ TaskBearer: [] }]);
  assert.deepEqual(
    operation.requestBody.content['application/json'].schema,
    taskMcpTools.find((t) => t.name === 'browser_task_submit').inputSchema,
  );
  assert.ok(doc.paths['/v3/runs/{runId}/evidence/{evidenceId}/download']);
  assert.equal(doc.paths['/v3/executions'], undefined);
});
