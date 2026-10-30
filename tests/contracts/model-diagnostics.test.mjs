import assert from 'node:assert/strict';
import test from 'node:test';
import {
  validateModelCallWrite,
  validateRuntimeRequest,
} from '../../contracts/dist/index.js';

/** 诊断夹具只验证协议，不代表供应商故障或真实 HTTP 回执。 */
const diagnostics = {
  phase: 'RESPONSE_PARSE',
  httpStatus: 504,
  contentType: 'text/html',
  responseFormat: 'html',
  responseBytes: 42,
  reason: 'GATEWAY_TIMEOUT',
};
const result = {
  finishedAt: '2026-10-30T00:00:00Z',
  status: 'ERROR',
  response: null,
  error: 'INVALID_JSON',
  promptTokens: null,
  completionTokens: null,
  elapsedMs: 83415,
};

// 范围：新旧审计回执与 runtime 共用结构，额外原文和未知字段被拒绝；不验证数据库持久化。
test('诊断为可选封闭对象，旧回执仍兼容且不能夹带任意错误原文', () => {
  for (const value of [result, { ...result, diagnostics }]) {
    assert.equal(
      validateModelCallWrite({ phase: 'finish', result: value }),
      true,
    );
    assert.equal(
      validateRuntimeRequest({
        type: 'trace_finish',
        revision: 1,
        result: value,
      }),
      true,
    );
  }
  for (const invalid of [
    { ...diagnostics, body: 'secret' },
    { ...diagnostics, httpStatus: 999 },
    { ...diagnostics, contentType: 'text/html; secret' },
    { ...diagnostics, reason: 'arbitrary provider message' },
  ]) {
    assert.equal(
      validateModelCallWrite({
        phase: 'finish',
        result: { ...result, diagnostics: invalid },
      }),
      false,
    );
    assert.equal(
      validateRuntimeRequest({
        type: 'trace_finish',
        revision: 1,
        result: { ...result, diagnostics: invalid },
      }),
      false,
    );
  }
});
