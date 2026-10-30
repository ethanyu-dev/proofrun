import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import {
  accessClientIp,
  type ClientIpPolicy,
} from '../src/modules/access/client-ip.js';
import { parseTrustedProxies } from '../src/config.js';

/** 注入地址只用于模拟链路，不能证明 Railway 或 Cloudflare 线上实际重写了请求头。 */
const EDGE_PEER = '100.64.0.2';

// 范围：默认不信任头、固定网段和 Railway 模式；真实边缘覆盖行为由发布后请求单独核验。
test('客户端 IP 解析遵循部署策略而不跟随伪造的转发头', async (t) => {
  assert.equal(parseTrustedProxies('railway'), 'railway');
  const cases: {
    policy: ClientIpPolicy;
    headers: Record<string, string>;
    expected: string;
  }[] = [
    {
      policy: {},
      headers: { 'x-real-ip': '192.0.2.1', 'x-forwarded-for': '192.0.2.2' },
      expected: EDGE_PEER,
    },
    {
      policy: { trustedProxies: ['100.64.0.2'] },
      headers: { 'x-real-ip': '192.0.2.1', 'x-forwarded-for': '192.0.2.2' },
      expected: '192.0.2.2',
    },
    {
      policy: { trustedProxies: 'railway' },
      headers: { 'x-real-ip': '198.51.100.1', 'x-forwarded-for': '192.0.2.2' },
      expected: '198.51.100.1',
    },
    {
      policy: { trustedProxies: 'railway' },
      headers: { 'x-real-ip': '::ffff:198.51.100.1' },
      expected: '198.51.100.1',
    },
    {
      policy: { trustedProxies: 'railway' },
      headers: { 'x-real-ip': '2001:db8::1' },
      expected: '2001:db8::1',
    },
    {
      policy: { trustedProxies: 'railway' },
      headers: { 'x-forwarded-for': '192.0.2.2' },
      expected: EDGE_PEER,
    },
    {
      policy: { trustedProxies: 'railway' },
      headers: { 'x-real-ip': '192.0.2.1, 192.0.2.2' },
      expected: EDGE_PEER,
    },
    {
      policy: { trustedProxies: 'railway' },
      headers: { 'x-real-ip': 'fe80::1%eth0' },
      expected: EDGE_PEER,
    },
  ];
  for (const { policy, headers, expected } of cases) {
    const app = Fastify({
      trustProxy: Array.isArray(policy.trustedProxies)
        ? policy.trustedProxies
        : false,
    });
    t.after(() => app.close());
    app.get('/', (request) => ({ ip: accessClientIp(request, policy) }));
    const response = await app.inject({
      url: '/',
      remoteAddress: EDGE_PEER,
      headers,
    });
    assert.deepEqual(response.json(), { ip: expected });
  }
});

// 范围：Cloudflare 的 IPv4/IPv6 网段校验、头缺失和绕过 CDN 的伪造；不验证 Cloudflare Worker 的业务配置。
test('只有经过 Cloudflare 官方出口的请求才解析 CDN 来源头', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  app.get('/', (request) => ({
    ip: accessClientIp(request, {
      trustedProxies: 'railway',
      trustedCdn: 'cloudflare',
    }),
  }));
  for (const [edge, forwarded, expected] of [
    ['104.21.68.37', '198.51.100.8', '198.51.100.8'],
    ['2606:4700::1234', '2001:db8::8', '2001:db8::8'],
    ['198.51.100.8', '192.0.2.88', '198.51.100.8'],
    ['104.21.68.37', '192.0.2.1, 192.0.2.2', '104.21.68.37'],
    ['104.21.68.37', '', '104.21.68.37'],
    ['', '192.0.2.88', EDGE_PEER],
  ]) {
    const response = await app.inject({
      url: '/',
      remoteAddress: EDGE_PEER,
      headers: { 'x-real-ip': edge!, 'cf-connecting-ip': forwarded! },
    });
    assert.deepEqual(response.json(), { ip: expected });
  }
});
