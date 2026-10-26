import test from 'node:test';
import assert from 'node:assert/strict';
import {
  requiredCapabilities,
  supportsCapabilities,
  recoverableFocusFailure,
} from '../../contracts/dist/index.js';

// 范围：协议版本与明确需求匹配；不代表节点实际实现已经通过浏览器验收。
test('旧节点不能接需要运行时探针的任务，普通 DOM 用例保持兼容', () => {
  assert.deepEqual(requiredCapabilities({ description: '检查首页标题' }), []);
  const needs = requiredCapabilities({
    description: '检查 Service Worker',
    expected: ['CacheStorage 不含敏感接口', '响应头 no-store'],
  });
  assert.deepEqual(needs, ['runtimeEvidenceV1', 'networkDetailsV1']);
  assert.equal(supportsCapabilities({}, needs), false);
  assert.equal(
    supportsCapabilities(
      { runtimeEvidenceVersion: 1, networkDetailsVersion: 1 },
      needs,
    ),
    true,
  );
  assert.equal(supportsCapabilities({}, []), true);
});

// 范围：仅明确未发送按键且已回执的聚焦失败允许重新观察；缺字段和未知传输均不豁免。
test('焦点恢复必须具备完整未发送按键的证明', () => {
  const command = {
    type: 'browser.act',
    action: 'press',
    target: 'current-target',
  };
  const result = {
    operationStatus: 'UNKNOWN',
    effect: 'MAY_HAVE_HAPPENED',
    error: { code: 'KEYBOARD_FOCUS_UNCONFIRMED' },
    data: { keyboard: { keyDispatched: false, focusAttempted: true } },
  };
  assert.equal(recoverableFocusFailure(command, result), true);
  assert.equal(
    recoverableFocusFailure({ type: 'browser.act', action: 'press' }, result),
    false,
  );
  for (const changed of [
    { ...result, data: {} },
    { ...result, error: { code: 'DOM_ENGINE_FAILED' } },
    {
      ...result,
      data: { keyboard: { keyDispatched: true, focusAttempted: true } },
    },
  ])
    assert.equal(recoverableFocusFailure(command, changed), false);
  assert.equal(
    recoverableFocusFailure({ type: 'browser.act', action: 'click' }, result),
    false,
  );
});

// 范围：固定激活门禁不接受页面加载、未激活注册或其他 origin；不把否定描述提升为新业务标准。
test('明确 SW 激活准备必须有同源适用注册证据', async () => {
  const {
    requiresActiveServiceWorker,
    activeServiceWorkerObserved,
    executionOutcome,
  } = await import('../../contracts/dist/index.js');
  assert.equal(
    requiresActiveServiceWorker({
      type: 'setup',
      description: '打开 /novi，等待 Service Worker 安装并激活',
    }),
    true,
  );
  assert.equal(
    requiresActiveServiceWorker({
      type: 'setup',
      description: '不等待 Service Worker 激活',
    }),
    false,
  );
  assert.equal(
    activeServiceWorkerObserved('https://site.test/novi', {
      status: 'observed',
      origin: 'https://site.test',
      serviceWorker: { registrations: [] },
    }),
    false,
  );
  const data = {
    status: 'observed',
    origin: 'https://site.test',
    serviceWorker: {
      registrations: [
        { scope: 'https://site.test/', active: { state: 'activated' } },
      ],
    },
  };
  assert.equal(
    activeServiceWorkerObserved('https://site.test/novi', data),
    true,
  );
  assert.equal(
    activeServiceWorkerObserved('https://other.test/novi', data),
    false,
  );
  data.serviceWorker.registrations[0].active.state = 'installing';
  assert.equal(
    activeServiceWorkerObserved('https://site.test/novi', data),
    false,
  );
  assert.equal(
    executionOutcome({ state: 'ERROR', code: 'CAPABILITY_UNSUPPORTED' })
      .category,
    'CAPABILITY_ERROR',
  );
});
