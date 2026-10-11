import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { createRequire } from 'node:module';
import {
  readSavedCredential,
  saveCredential,
  clearSavedCredential,
  readRestorableCredential,
  suspendCredentialRestore,
} from '../../apps/console/src/credential-storage.ts';
import { Connect } from '../../apps/console/src/components/connect.tsx';

/** 仅渲染连接页首屏；服务端渲染不会执行 effect 或发送验证请求。 */
const require = createRequire(
  new URL('../../apps/console/package.json', import.meta.url),
);
const { createElement } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

/** 每个用例隔离本地存储并恢复全局属性，避免把测试凭据写入真实浏览器。 */
function mockStorage(context: TestContext) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map([['theme', 'dark']]);
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  context.after(() => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });
  return values;
}

/** 禁止在静态首屏测试中把尚未验证的凭据误报为已连接。 */
function renderConnect(autoRestore = true): string {
  return renderToStaticMarkup(
    createElement(Connect, {
      autoRestore,
      onConnect: () => assert.fail('静态渲染不得建立连接'),
    }),
  );
}

// 范围：模拟同一站点存储的保存、重读、替换与清除；不替代浏览器跨站隔离或 API 凭据验证。
test('凭据可在再次读取时恢复，清除不影响其他本地配置', (context) => {
  const values = mockStorage(context);
  assert.equal(readSavedCredential(), '');
  assert.equal(saveCredential('fixture-token-first'), true);
  assert.equal(readSavedCredential(), 'fixture-token-first');
  assert.equal(saveCredential('fixture-token-replacement'), true);
  assert.equal(readSavedCredential(), 'fixture-token-replacement');
  assert.equal(clearSavedCredential(), true);
  assert.equal(readSavedCredential(), '');
  assert.equal(readRestorableCredential(), '');
  assert.deepEqual([...values], [['theme', 'dark']]);
});

// 范围：兼容升级前已保存的凭据，首屏直接展示恢复状态；不验证 effect、真实 API 或浏览器刷新。
test('已有凭据直接进入恢复状态，首屏不闪现登录表单', (context) => {
  const values = mockStorage(context);
  values.set('proofrun.console.credential', '  fixture-token  ');
  assert.equal(readRestorableCredential(), 'fixture-token');
  const html = renderConnect();
  assert.ok(html.includes('正在恢复连接'));
  assert.ok(!html.includes('id="admin-token"'));
  assert.ok(!html.includes('fixture-token'));
});

// 范围：主动断开的标记保留在存储中，再次读取不恢复，手动连接成功后启用；不模拟跨标签页即时同步。
test('断开后保留表单记忆，重新连接才启用自动恢复', (context) => {
  mockStorage(context);
  assert.equal(saveCredential('fixture-token'), true);
  assert.equal(suspendCredentialRestore(), true);
  assert.equal(readSavedCredential(), 'fixture-token');
  assert.equal(readRestorableCredential(), '');
  assert.ok(renderConnect().includes('id="admin-token"'));
  assert.equal(saveCredential('fixture-replacement'), true);
  assert.equal(readRestorableCredential(), 'fixture-replacement');
  assert.ok(renderConnect().includes('正在恢复连接'));
});

// 范围：无凭据、清除凭据和空白凭据均显示手动表单；不验证浏览器站点设置中的数据清除行为。
test('没有可恢复凭据时显示连接表单', (context) => {
  mockStorage(context);
  assert.ok(renderConnect().includes('id="admin-token"'));
  saveCredential('fixture-token');
  clearSavedCredential();
  assert.ok(renderConnect().includes('id="admin-token"'));
  saveCredential('   ');
  assert.equal(readRestorableCredential(), '');
  assert.ok(renderConnect().includes('id="admin-token"'));
});

// 范围：本地可读但禁止写入时，当前页的断开开关仍阻止重连；不替代完整浏览器点击交互。
test('无法保存断开标记时仍可在当前页禁止自动恢复', (context) => {
  mockStorage(context);
  saveCredential('fixture-token');
  context.mock.method(localStorage, 'setItem', () => {
    throw new Error('storage read-only');
  });
  assert.equal(suspendCredentialRestore(), false);
  assert.equal(readRestorableCredential(), 'fixture-token');
  assert.ok(renderConnect(false).includes('id="admin-token"'));
});

// 范围：存储访问被浏览器策略拒绝时返回可处理状态，不抛出导致白屏；不模拟各浏览器隐私模式。
test('浏览器禁止本地存储时操作不会抛出异常', (context) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new Error('storage disabled');
    },
  });
  context.after(() => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });
  assert.equal(readSavedCredential(), '');
  assert.equal(readRestorableCredential(), '');
  assert.equal(saveCredential('fixture-token'), false);
  assert.equal(suspendCredentialRestore(), false);
  assert.equal(clearSavedCredential(), false);
  assert.ok(renderConnect().includes('id="admin-token"'));
});
