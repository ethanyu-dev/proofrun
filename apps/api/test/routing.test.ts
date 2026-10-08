import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeDomain,
  resolveRoute,
  routeKey,
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

// 范围：配置拒绝 URL、非法通配符和无效标签；不替代接口权限、唯一约束或数据库事务测试。
test('域名配置拒绝含混输入', () => {
  for (const invalid of [
    '',
    '*',
    '*example.com',
    'a.*.example.com',
    '*.*.example.com',
    '*.',
    '*.127.0.0.1',
    '*.127.1',
    '*.0x7f000001',
    '*.[::1]',
    '*.https://example.com',
    '*.example.com:443',
    '*.example.com/a',
    '*. example.com',
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

// 范围：合法通配规则沿用大小写、根域点和国际化归一化；不访问 DNS 或验证域名所有权。
test('通配规则只归一化后缀并保留前缀', () => {
  assert.equal(normalizeDomain(' *.EXAMPLE.COM. '), '*.example.com');
  assert.equal(normalizeDomain('*.例子.测试'), '*.xn--fsqu00a.xn--0zwm56d');
  assert.equal(normalizeDomain('*.internal'), '*.internal');
  const suffix = [63, 63, 63, 59].map((length) => 'a'.repeat(length)).join('.');
  assert.equal(normalizeDomain(`*.${suffix}`).length, 253);
  assert.throws(() => normalizeDomain(`*.${suffix}a`), /域名/);
});

// 范围：快照查找的优先级、标签边界、池隔离与 IP 排除；不替代数据库领取事务和节点连接测试。
test('域名路由优先精确匹配，其次选择最长通配后缀', () => {
  const routes = new Map([
    [routeKey('internal', '*.example.com'), 'broad'],
    [routeKey('internal', '*.team.example.com'), 'narrow'],
    [routeKey('internal', 'app.team.example.com'), 'exact'],
    [routeKey('other', '*.example.com'), 'other-pool'],
    [routeKey('internal', '*.xn--fsqu00a.xn--0zwm56d'), 'idn'],
    [routeKey('internal', '*.internal'), 'private'],
    [routeKey('internal', '*.0.1'), 'numeric-suffix'],
    [routeKey('internal', '127.0.0.2'), 'ip'],
  ]);
  for (const [url, expected] of [
    ['https://APP.TEAM.EXAMPLE.COM.:8443/path', 'exact'],
    ['https://deep.app.team.example.com', 'narrow'],
    ['https://team.example.com', 'broad'],
    ['https://a.b.example.com', 'broad'],
    ['https://a.example.com', 'broad'],
    ['https://example.com', undefined],
    ['https://badexample.com', undefined],
    ['https://example.com.evil.invalid', undefined],
    ['https://app.例子.测试', 'idn'],
    ['https://service.internal', 'private'],
    ['http://127.0.0.1', undefined],
    ['http://127.0.0.2', 'ip'],
    ['http://[::1]', undefined],
    ['invalid-url', undefined],
  ] as const) {
    assert.equal(
      resolveRoute(routes, 'internal', targetHostname(url)),
      expected,
      url,
    );
  }
  assert.equal(resolveRoute(routes, 'other', 'a.example.com'), 'other-pool');
  assert.equal(resolveRoute(routes, 'missing', 'a.example.com'), undefined);
});
