import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { Window } from 'happy-dom';
import { ApiClient } from '../../apps/console/src/api.ts';
import {
  ModelCallStatus,
  modelCallDuration,
  type ModelCallMetadata,
} from '../../apps/console/src/components/model-call-status.tsx';

/** 使用 Console 的 React，DOM 和 HTTP 均为夹具。 */
const require = createRequire(
  new URL('../../apps/console/package.json', import.meta.url),
);
const { createElement: h, act } = require('react');
/** 构造同一步的显式重试记录，不根据全局调用序号推断尝试次数。 */
function call(overrides: Partial<ModelCallMetadata> = {}): ModelCallMetadata {
  return {
    id: 'call-1',
    callIndex: 8,
    decisionIndex: 8,
    model: 'fixture',
    purpose: 'DECISION',
    startedAt: '2026-10-30T00:00:00Z',
    finishedAt: null,
    status: 'PENDING',
    error: null,
    promptTokens: null,
    completionTokens: null,
    elapsedMs: null,
    imagesOmitted: 0,
    archived: false,
    requestSha256: 'a'.repeat(64),
    stepId: 'step-1',
    attempt: 2,
    maxAttempts: 3,
    timeoutMs: 120000,
    ...overrides,
  };
}

// 范围：纯时间投影在终态和时钟偏差时不累加假耗时；不验证生产时钟同步。
test('缺失回执的终态停止计时，完成耗时优先使用服务端回执', () => {
  const now = Date.parse('2026-10-30T00:01:00Z');
  assert.equal(modelCallDuration(call(), true, now), '60 秒');
  assert.equal(modelCallDuration(call(), false, now), '耗时未记录');
  assert.equal(modelCallDuration(call(), true, 0), '0 秒');
  assert.equal(
    modelCallDuration(call({ status: 'ERROR', elapsedMs: 83415 }), false, now),
    '83.4 秒',
  );
});

// 范围：挂载组件验证计时、定期刷新、失败可见、终态停止及跨执行迟到隔离；不验证真实服务器或浏览器像素。
test('模型面板显示等待和重试，轮询失败保留记录且切换执行丢弃旧响应', async (context) => {
  const window = new Window({ url: 'http://localhost' });
  const values = {
    window,
    document: window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(
    Object.keys(values).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(values))
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  const { createRoot } = require('react-dom/client');
  const container = window.document.createElement('div');
  window.document.body.append(container);
  const root = createRoot(container);
  const api = new ApiClient('fixture');
  const started = Date.now() - 3000;
  const error = call({
    id: 'failed',
    callIndex: 7,
    attempt: 1,
    status: 'ERROR',
    error: 'INVALID_JSON',
    elapsedMs: 83415,
    diagnostics: {
      phase: 'RESPONSE_PARSE',
      httpStatus: 504,
      contentType: 'text/html',
      responseFormat: 'html',
      responseBytes: 42,
      reason: 'GATEWAY_TIMEOUT',
    },
  });
  const pending = call({ startedAt: new Date(started).toISOString() });
  let reads = 0;
  let resolveOld: ((value: unknown) => void) | undefined;
  let oldSignal: AbortSignal | undefined;
  context.mock.method(
    api,
    'json',
    async (path: string, signal: AbortSignal) => {
      if (path.includes('/old/')) {
        oldSignal = signal;
        return new Promise((resolve) => {
          resolveOld = resolve;
        });
      }
      if (path.includes('/new/'))
        return {
          calls: [
            call({
              id: 'new-call',
              stepId: 'step-2',
              attempt: undefined,
              maxAttempts: undefined,
              status: 'ERROR',
              error: 'HTTP_ERROR',
              elapsedMs: 20,
            }),
          ],
        };
      reads++;
      if (reads === 2) throw new Error('fixture unavailable');
      return { calls: [error, pending] };
    },
  );
  const render = async (
    executionId = 'current',
    active = true,
    stepId?: string,
  ) => {
    await act(async () => {
      root.render(h(ModelCallStatus, { api, executionId, active, stepId }));
    });
  };
  try {
    await render();
    assert.match(container.textContent!, /等待模型回执 3 秒/);
    assert.match(container.textContent!, /重试 · 第 2\/3 次尝试/);
    assert.match(container.textContent!, /HTTP 504/);
    assert.match(container.textContent!, /text\/html/);
    assert.match(container.textContent!, /83.4 秒/);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1100));
    });
    assert.match(container.textContent!, /等待模型回执 [45] 秒/);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 4100));
    });
    assert.equal(reads, 2);
    assert.match(container.textContent!, /模型记录同步失败/);
    assert.match(container.textContent!, /HTTP 504/);
    await act(async () => {
      container.querySelector('button')!.click();
    });
    assert.equal(reads, 3);
    assert.doesNotMatch(container.textContent!, /模型记录同步失败/);
    await render('current', false);
    assert.match(container.textContent!, /执行已结束，模型回执未确认/);
    assert.doesNotMatch(container.textContent!, /等待模型回执 \d/);
    await render('old');
    await render('new', false, 'step-2');
    assert.equal(oldSignal!.aborted, true);
    await act(async () => {
      resolveOld!({ calls: [error] });
    });
    assert.doesNotMatch(container.textContent!, /HTTP 504/);
    assert.match(container.textContent!, /尝试次数未记录/);
    assert.match(container.textContent!, /历史诊断未记录/);
    await render('new', false, 'step-1');
    assert.match(container.textContent!, /暂无模型请求记录/);
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
