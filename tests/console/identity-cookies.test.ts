import assert from 'node:assert/strict';
import test from 'node:test';
import {
  identityCookiePayload,
  type CookieDraft,
} from '../../apps/console/src/identity-cookies.ts';

/** 使用非真实凭据验证提交语义；不证明浏览器注入或服务端登录有效。 */
const row = (value: Partial<CookieDraft> = {}): CookieDraft => ({
  id: 'local-row',
  name: 'session',
  value: 'fixture-value',
  httpOnly: true,
  ...value,
});

// 范围：未编辑、明确清空、新建空行分别保留、清空、不发送，防止编辑表单误删凭据。
test('Cookie 表单区分保留、清空和未填写', () => {
  assert.equal(identityCookiePayload(null, true), undefined);
  assert.equal(identityCookiePayload([], true), '[]');
  assert.equal(
    identityCookiePayload([row({ name: '', value: '' })], false),
    undefined,
  );
  assert.throws(
    () => identityCookiePayload([row({ name: '', value: '' })], true),
    /请填写 Cookie/,
  );
});

// 范围：多行提交保留 HttpOnly 与合法空值，丢弃 UI 标识和未填写行；服务端负责完整 Cookie 格式校验。
test('Cookie 表单只发送三个字段并保留开关与空值', () => {
  assert.deepEqual(
    JSON.parse(
      identityCookiePayload(
        [
          row(),
          row({ name: 'empty', value: '', httpOnly: false }),
          row({ name: '', value: '' }),
        ],
        false,
      )!,
    ),
    [
      { name: 'session', value: 'fixture-value', httpOnly: true },
      { name: 'empty', value: '', httpOnly: false },
    ],
  );
});

// 范围：缺少名称和重复名称在提交前给出明确提示，不把输入的秘密写入错误消息。
test('Cookie 表单拒绝缺失或重复名称', () => {
  assert.throws(
    () => identityCookiePayload([row({ name: '' })], false),
    /Name/,
  );
  assert.throws(() => identityCookiePayload([row(), row()], false), /不能重复/);
});
