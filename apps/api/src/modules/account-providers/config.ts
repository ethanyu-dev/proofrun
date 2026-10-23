import { lstatSync, readFileSync } from 'node:fs';
import { normalizeOrigin } from '@dev-pass/contracts';

/** 固定的服务地址和接收密钥均来自部署配置，Case 只能引用 id。 */
export interface DevPassConfig {
  /** 对外可见的来源引用。 */
  id: string;
  /** MCP 端点，不接受重定向。 */
  url: string;
  /** DevPass 登记的稳定调用方身份。 */
  clientId: string;
  /** 访问凭据文件，轮换后下次请求读取。 */
  tokenFile: string;
  /** 接收 key ID 到私钥文件的映射；旧租约结束前保留旧键。 */
  privateKeyFiles: Record<string, string>;
  /** 与 DevPass 调用方策略一致的申请时长上限。 */
  maxDurationSeconds: number;
  /** 仅允许回环开发服务使用 HTTP。 */
  allowLoopback?: boolean;
}

/** 私密配置读取失败只返回固定错误，避免把内容或密码带入日志。 */
export function privateText(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 65_536)
    throw new Error('DevPass 私密文件必须为受限权限的普通文件');
  return readFileSync(path, 'utf8').trim();
}

/** 配置在启动时校验，密钥仅在可信适配器按版本使用。 */
export function loadDevPass(path?: string): DevPassConfig | undefined {
  if (!path) return undefined;
  const value = JSON.parse(privateText(path)) as DevPassConfig;
  if (
    !value ||
    Object.keys(value).some(
      (k) =>
        ![
          'id',
          'url',
          'clientId',
          'tokenFile',
          'privateKeyFiles',
          'maxDurationSeconds',
          'allowLoopback',
        ].includes(k),
    ) ||
    typeof value.id !== 'string' ||
    !/^[A-Za-z0-9_-]{1,80}$/.test(value.id) ||
    typeof value.clientId !== 'string' ||
    !value.clientId ||
    typeof value.tokenFile !== 'string' ||
    !value.tokenFile ||
    typeof value.url !== 'string' ||
    !value.privateKeyFiles ||
    typeof value.privateKeyFiles !== 'object' ||
    Array.isArray(value.privateKeyFiles) ||
    !Object.values(value.privateKeyFiles).length ||
    Object.values(value.privateKeyFiles).some(
      (p) => typeof p !== 'string' || !p,
    ) ||
    !Number.isInteger(value.maxDurationSeconds) ||
    value.maxDurationSeconds < 60 ||
    value.maxDurationSeconds > 7200 ||
    (value.allowLoopback !== undefined &&
      typeof value.allowLoopback !== 'boolean')
  )
    throw new Error('DevPass 部署配置无效');
  const url = new URL(value.url);
  normalizeOrigin(url.origin, value.allowLoopback);
  if (url.username || url.password || url.hash || url.search)
    throw new Error('DevPass MCP 地址无效');
  return value;
}
