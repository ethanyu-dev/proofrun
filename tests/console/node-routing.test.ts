import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { ApiClient } from '../../apps/console/src/api.ts';
import {
  NodeRoutingSummary,
  NodeRoutingEditor,
  type ConsoleNode,
} from '../../apps/console/src/components/node-routing.tsx';

/** 复用控制台的 React 渲染器，检查实际组件而非重复实现条件判断。 */
const require = createRequire(
  new URL('../../apps/console/package.json', import.meta.url),
);
const { createElement } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
/** 模拟旧 API 返回的完整节点，但不包含新版本域名字段。 */
const legacyNode: ConsoleNode = {
  id: 'legacy-node',
  name: '旧版节点',
  pool: 'internal',
  node_epoch: null,
  capacity: 1,
  capabilities: {},
  inventory: [],
  last_seen_at: null,
  revoked_at: null,
  online: true,
  occupied: 0,
};

/** 编辑器和卡片共同验证，避免修复 length 后仍在 join 处崩溃。 */
function render(node: ConsoleNode) {
  return {
    summary: renderToStaticMarkup(
      createElement(NodeRoutingSummary, { node, edit() {} }),
    ),
    editor: renderToStaticMarkup(
      createElement(NodeRoutingEditor, {
        node,
        api: new ApiClient('fixture-routing-only'),
        close() {},
        saved() {},
      }),
    ),
  };
}

// 范围：旧响应缺少字段时实际组件不崩溃且禁用编辑；不覆盖浏览器请求或真实 API 升级。
test('旧版节点响应仍能渲染且不冒充空域名配置', () => {
  const { summary, editor } = render(legacyNode);
  assert.match(summary, /更新并重启 API/);
  assert.match(summary, /disabled=""/);
  assert.doesNotMatch(summary, /未绑定域名/);
  assert.match(editor, /更新并重启 API/);
  assert.doesNotMatch(editor, /<form/);
});

// 范围：部分升级和异常字段不会开放带未知版本的写入；不代替服务端协议验证。
test('域名列表或配置版本不完整时拒绝编辑', () => {
  for (const fields of [
    { routing_domains: [] },
    { routing_revision: 0 },
    { routing_domains: null, routing_revision: 0 },
    { routing_domains: 'example.com', routing_revision: 0 },
    { routing_domains: [null], routing_revision: 0 },
    { routing_domains: [], routing_revision: -1 },
    { routing_domains: [], routing_revision: '0' },
  ]) {
    const { summary, editor } = render({
      ...legacyNode,
      ...fields,
    } as ConsoleNode);
    assert.match(summary, /disabled=""/);
    assert.doesNotMatch(editor, /<form/);
  }
});

// 范围：新响应的空配置和已有配置保留正常展示与编辑；不验证保存接口或真实域名调度。
test('完整域名配置允许展示与编辑，包括初始零版本', () => {
  const empty = render({
    ...legacyNode,
    routing_domains: [],
    routing_revision: 0,
  });
  assert.match(empty.summary, /未绑定域名/);
  assert.doesNotMatch(empty.summary, /disabled=""/);
  assert.match(empty.editor, /<form/);
  const configured = render({
    ...legacyNode,
    routing_domains: ['example.com'],
    routing_revision: 1,
  });
  assert.match(configured.summary, /<li>example.com<\/li>/);
  assert.match(configured.editor, />example.com<\/textarea>/);
});
