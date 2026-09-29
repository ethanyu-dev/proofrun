import assert from 'node:assert/strict';
import test from 'node:test';
import {
  readSavedCredential,
  saveCredential,
  clearSavedCredential,
} from '../../apps/console/src/credential-storage.ts';

// 范围：模拟同一站点存储的保存、重读、替换与清除；不替代浏览器跨站隔离或 API 凭据验证。
test('凭据可在再次读取时恢复，清除不影响其他本地配置', (context) => {
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
  assert.equal(readSavedCredential(), '');
  assert.equal(saveCredential('fixture-token-first'), true);
  assert.equal(readSavedCredential(), 'fixture-token-first');
  assert.equal(saveCredential('fixture-token-replacement'), true);
  assert.equal(readSavedCredential(), 'fixture-token-replacement');
  assert.equal(clearSavedCredential(), true);
  assert.equal(readSavedCredential(), '');
  assert.deepEqual([...values], [['theme', 'dark']]);
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
  assert.equal(saveCredential('fixture-token'), false);
  assert.equal(clearSavedCredential(), false);
});
