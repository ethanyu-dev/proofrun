import { lstatSync, readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { ApiError, bearer, digest } from '../../domain.js';

/** 委托、浏览器操作和验证进度分别授权；控制句柄不能扩大凭据 scope。 */
export const PUBLIC_SCOPES = [
  'browser:delegate',
  'verification:submit',
  'runs:read',
  'evidence:read',
  'runs:cancel',
  'browser:control',
  'verification:control',
] as const;
export type PublicScope = (typeof PUBLIC_SCOPES)[number];
export type PublicChannel = 'browser' | 'verification';
/** 凭据文件中仅保存摘要；相同 principal 可用不同 token 访问两个端点。 */
export interface PublicCredential {
  /** 稳定的调用方归属，不能由工具参数指定。 */
  principalId: string;
  /** 原始高熵令牌的 SHA-256 十六进制摘要。 */
  tokenSha256: string;
  /** 允许连接的 MCP 和对应 HTTP 接入面。 */
  channels: PublicChannel[];
  /** 工具权限还必须结合资源归属校验。 */
  scopes: PublicScope[];
}
/** 配置验证也用于测试注入，避免错误配置静默扩大权限。 */
export function validatePublicCredentials(input: unknown): PublicCredential[] {
  const invalid = () =>
    new Error(
      'MCP 凭据配置必须包含有效 principalId、tokenSha256、channels 和 scopes',
    );
  if (!Array.isArray(input) || !input.length || input.length > 100)
    throw invalid();
  const hashes = new Set<string>();
  for (const entry of input) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      Object.keys(entry).some(
        (key) =>
          !['principalId', 'tokenSha256', 'channels', 'scopes'].includes(key),
      ) ||
      typeof entry.principalId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,80}$/.test(entry.principalId) ||
      typeof entry.tokenSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(entry.tokenSha256) ||
      hashes.has(entry.tokenSha256) ||
      !Array.isArray(entry.channels) ||
      !entry.channels.length ||
      entry.channels.some(
        (x: unknown) => !['browser', 'verification'].includes(x as string),
      ) ||
      !Array.isArray(entry.scopes) ||
      !entry.scopes.length ||
      entry.scopes.some(
        (x: unknown) => !PUBLIC_SCOPES.includes(x as PublicScope),
      )
    )
      throw invalid();
    hashes.add(entry.tokenSha256);
  }
  return structuredClone(input);
}
/** 配置不随工具请求加载；轮换须重载服务，文件内容和明文 token 均不进入日志。 */
export function loadPublicCredentials(
  path?: string,
): PublicCredential[] | undefined {
  if (!path) return undefined;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.mode & 0o077 || stat.size > 65536)
    throw new Error('MCP 凭据配置必须是权限 0600 的普通文件');
  return validatePublicCredentials(JSON.parse(readFileSync(path, 'utf8')));
}
/** 认证只接受部署配置的服务凭据，管理员和 worker token 不自动获得公共权限。 */
export function authenticatePublic(
  header: string | undefined,
  channel: PublicChannel,
  credentials: PublicCredential[],
): PublicCredential {
  const hash = Buffer.from(digest(bearer(header)), 'hex');
  const principal = credentials.find((item) =>
    timingSafeEqual(hash, Buffer.from(item.tokenSha256, 'hex')),
  );
  if (!principal) throw new ApiError(401, 'UNAUTHORIZED', '公共接入凭据无效');
  if (!principal.channels.includes(channel))
    throw new ApiError(403, 'SCOPE_FORBIDDEN', '凭据未授权此接入面');
  return principal;
}
