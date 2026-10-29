import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { App } from '../../apps/console/src/app.tsx';

const require = createRequire(
  new URL('../../apps/console/package.json', import.meta.url),
);
const { createElement } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

// 范围：各管理路由首屏及已保存但未验证的凭据均不得渲染基准内容；不替代服务端 token 校验和浏览器点击验收。
test('Benchmark 与其他管理路由共用连接门禁，已保存凭据也要先验证', (t) => {
  const savedLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const savedStorage = Object.getOwnPropertyDescriptor(
    globalThis,
    'localStorage',
  );
  t.after(() => {
    for (const [name, descriptor] of [
      ['location', savedLocation],
      ['localStorage', savedStorage],
    ] as const) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  let token: string | null = null;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) =>
        key === 'proofrun.console.credential' ? token : null,
    },
  });
  for (const hash of ['#/benchmarks', '#/tasks', '#/nodes']) {
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: { hash },
    });
    const html = renderToStaticMarkup(createElement(App));
    assert.match(html, /连接 ProofRun/);
    assert.doesNotMatch(
      html,
      /查看本地 Benchmark|运行真实基准|发起线上基准|导入 Benchmark 结果/,
    );
  }
  token = 'fixture-unverified-token';
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { hash: '#/benchmarks' },
  });
  const html = renderToStaticMarkup(createElement(App));
  assert.match(html, /正在恢复连接/);
  assert.doesNotMatch(html, /查看本地 Benchmark|运行真实基准|发起线上基准/);
});
