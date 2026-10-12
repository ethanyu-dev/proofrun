import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { NodeVersion } from '../../apps/console/src/components/node-version.tsx';

/** 使用真实组件检查旧数据兼容，不构造页面请求或声称节点已升级。 */
const require = createRequire(
  new URL('../../apps/console/package.json', import.meta.url),
);
const { createElement } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

// 范围：明确区分未上报、开发构建和完整 release 标签；不验证心跳传输或浏览器布局。
test('节点版本显示上报事实，旧记录不冒充当前 release', () => {
  for (const runtime of [undefined, null]) {
    const html = renderToStaticMarkup(createElement(NodeVersion, { runtime }));
    assert.match(html, /未上报/);
    assert.doesNotMatch(html, /alpha/);
  }
  const html = renderToStaticMarkup(
    createElement(NodeVersion, {
      runtime: {
        version: 'node-v0.1.0-alpha.6',
        sourceCommit: 'a'.repeat(40),
        engineVersion: '0.38.1',
      },
    }),
  );
  assert.match(html, /node-v0.1.0-alpha.6/);
  assert.match(html, /title="a{40}"/);
  assert.match(html, /提交 a{8}/);
  assert.match(html, /引擎 0.38.1/);
  const dev = renderToStaticMarkup(
    createElement(NodeVersion, {
      runtime: {
        version: '0.1.0-dev',
        sourceCommit: null,
        engineVersion: '0.38.1',
      },
    }),
  );
  assert.match(dev, /0.1.0-dev/);
  assert.match(dev, /提交 未知/);
});
