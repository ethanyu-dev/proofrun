import { readFileSync, lstatSync } from 'node:fs';
import { ApiError } from '../../domain.js';
import { validateCatalog, type IdentityCatalog } from './catalog.js';

/** 只缓存短期元数据；到期请求失败不能继续分配已经撤销的身份。 */
const CACHE_MS = 30_000;
/** 请求与读取正文共享五秒上限。 */
const TIMEOUT_MS = 5_000;
/** 先限制字节数，再解析不受信任的提供方 JSON。 */
const MAX_BYTES = 1_048_576;
/** 提供方地址与令牌留在 API 进程，不进入任务或报告。 */
export interface CatalogProviderConfig {
  /** 管理员固定配置的元数据接口，不允许 case 覆盖。 */
  url: string;
  /** 私有 Bearer 文件，每次请求重新读取以支持轮换。 */
  tokenFile: string;
}
/** API 配置可注入本地库或受控外部提供方，两者均返回相同的无秘密元数据。 */
export type CatalogSource = IdentityCatalog | (() => Promise<IdentityCatalog>);

/** HTTPS 为默认边界，仅回环允许 HTTP，测试和本机代理也遵守相同规则。 */
export function providerUrl(value: string): string {
  const url = new URL(value);
  if (
    (url.protocol !== 'https:' &&
      !(
        url.protocol === 'http:' &&
        ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
      )) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('身份库提供方必须是无凭据的 HTTPS 地址或回环 HTTP 地址');
  return url.href;
}
/** 秘密文件按每次请求读取以支持轮换，异常不包含文件内容。 */
export function readProviderToken(path: string): string {
  const meta = lstatSync(path);
  if (!meta.isFile() || meta.size > 8192 || (meta.mode & 0o077) !== 0)
    throw new Error('invalid private token');
  const value = readFileSync(path, 'utf8').trim();
  if (!value || /[\r\n]/.test(value)) throw new Error('invalid private token');
  return value;
}
/** 外部返回未知字段（包括密码/Cookie）直接拒绝，不做透传或日志输出。 */
export class HttpCatalogProvider {
  /** 缓存只用于短期合并读取，到期后不得在故障时回退。 */
  private cache: { expires: number; value: IdentityCatalog } | undefined;
  /** 同一批并发提交共享请求，避免向身份库制造请求风暴。 */
  private pending: Promise<IdentityCatalog> | undefined;
  /** 已验证的固定地址，重定向不会变更它。 */
  private readonly url: string;
  constructor(
    private readonly config:
      CatalogProviderConfig | { url: string; readToken: () => string },
  ) {
    this.url = providerUrl(config.url);
  }
  /** 并发提交共用一个请求；缓存失效时不会悄悄退回旧库。 */
  async get(refresh = false): Promise<IdentityCatalog> {
    if (refresh) this.cache = undefined;
    if (this.cache && this.cache.expires > Date.now())
      return structuredClone(this.cache.value);
    this.pending ??= this.fetch().finally(() => {
      this.pending = undefined;
    });
    return structuredClone(await this.pending);
  }
  /** 拒绝响应中的未知字段及秘密；故障只返回固定诊断。 */
  private async fetch(): Promise<IdentityCatalog> {
    try {
      const response = await fetch(this.url, {
        headers: {
          Authorization: `Bearer ${'tokenFile' in this.config ? readProviderToken(this.config.tokenFile) : this.config.readToken()}`,
          Accept: 'application/json',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok || !response.body)
        throw new Error('provider unavailable');
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > MAX_BYTES) throw new Error('oversized');
        chunks.push(chunk);
      }
      const value = validateCatalog(
        JSON.parse(Buffer.concat(chunks).toString('utf8')),
      );
      this.cache = { expires: Date.now() + CACHE_MS, value };
      return value;
    } catch {
      throw new ApiError(
        503,
        'IDENTITY_PROVIDER_UNAVAILABLE',
        '外部测试身份库不可用或元数据不符合约定，请检查提供方',
      );
    }
  }
}
