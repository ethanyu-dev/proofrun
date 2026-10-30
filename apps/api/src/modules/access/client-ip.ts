import { BlockList, isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';

/** Cloudflare 官方出口网段快照（2026-10-30）；变更时需同步 IPv4/IPv6 两份列表。
 * 来源：https://www.cloudflare.com/ips-v4/ 与 https://www.cloudflare.com/ips-v6/。
 */
const CLOUDFLARE_RANGES = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
];
const cloudflare = new BlockList();
for (const range of CLOUDFLARE_RANGES) {
  const [address, prefix] = range.split('/');
  cloudflare.addSubnet(
    address!,
    Number(prefix),
    isIP(address!) === 6 ? 'ipv6' : 'ipv4',
  );
}

/** 普通部署按固定代理链解析；Railway 依赖其边缘重写及同环境私网的信任边界。 */
export interface ClientIpPolicy {
  /** Railway 没有稳定的边缘网段，此显式模式只读取平台重写的单值 X-Real-IP。 */
  trustedProxies?: string[] | 'railway' | undefined;
  /** 仅当上一跳地址属于 Cloudflare 官方网段时解析 CF-Connecting-IP。 */
  trustedCdn?: 'cloudflare' | undefined;
}

/** 拒绝列表、主机名和接口作用域；统一 IPv4 映射地址以适配 PostgreSQL inet。 */
export function normalizeIp(value: string | undefined): string | null {
  if (!value || value.includes('%')) return null;
  value = value.trim().toLowerCase();
  if (value.startsWith('::ffff:') && isIP(value.slice(7)) === 4)
    return value.slice(7);
  return isIP(value) ? value : null;
}

/** 多值头不能选取其中一个值冒充可信来源，必须回退到已验证的上一跳。 */
function headerIp(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name];
  return typeof value === 'string' ? normalizeIp(value) : null;
}

/** 此结果仅用于审计展示，不参与身份认证；私网请求缺少平台头时使用 TCP 对端。 */
export function accessClientIp(
  request: FastifyRequest,
  policy: ClientIpPolicy,
): string | null {
  const ip =
    policy.trustedProxies === 'railway'
      ? (headerIp(request, 'x-real-ip') ??
        normalizeIp(request.raw.socket.remoteAddress))
      : normalizeIp(request.ip);
  if (
    policy.trustedCdn !== 'cloudflare' ||
    !ip ||
    !cloudflare.check(ip, isIP(ip) === 6 ? 'ipv6' : 'ipv4')
  )
    return ip;
  return headerIp(request, 'cf-connecting-ip') ?? ip;
}
