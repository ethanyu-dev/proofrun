import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeDomain,
  targetHostname,
} from '../src/modules/nodes/routing.js';

// 范围：完整域名归一化与 URL 主机名一致；不访问 DNS、网络或真实浏览器。
test('域名匹配统一大小写、根域点与国际化域名，忽略端口和路径', () => {
  assert.equal(normalizeDomain(' EXAMPLE.COM. '), 'example.com');
  assert.equal(
    normalizeDomain('例子.测试'),
    targetHostname('https://例子.测试:8443/a?q=1'),
  );
  assert.equal(
    targetHostname('https://user@example.com.:8443/a'),
    'example.com',
  );
  assert.notEqual(
    normalizeDomain('example.com'),
    targetHostname('https://sub.example.com'),
  );
  assert.notEqual(
    normalizeDomain('example.com'),
    targetHostname('https://example.com.evil.invalid'),
  );
  assert.equal(normalizeDomain('127.0.0.1'), '127.0.0.1');
});

// 范围：配置拒绝 URL、通配符和无效标签；不替代接口权限、唯一约束或数据库事务测试。
test('域名配置拒绝含混输入', () => {
  for (const invalid of [
    '',
    '*.example.com',
    'https://example.com',
    'example.com:443',
    'example.com/a',
    'a@b.com',
    'example.com?x',
    'example.com#x',
    'exa mple.com',
    'example..com',
    '-bad.com',
    'bad_.com',
    'a'.repeat(64) + '.com',
    'example.com\\evil',
    '%65xample.com',
  ]) {
    assert.throws(() => normalizeDomain(invalid), /域名/, invalid);
  }
});
