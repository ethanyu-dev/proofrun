import { randomUUID } from 'node:crypto';
import { mkdir, lstat, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { ApiConfig } from '../../config.js';
import type { Database } from '../../db.js';
import { ApiError } from '../../domain.js';
import { validateCatalog, type IdentityCatalog } from './catalog.js';
import {
  HttpCatalogProvider,
  providerUrl,
  readProviderToken,
} from './provider.js';

/** 配置令牌上限与部署令牌文件相同，不允许换行形成额外请求头。 */
const MAX_TOKEN_BYTES = 8192;
/** 没有部署配置时，显式空库不会恢复历史身份。 */
const EMPTY: IdentityCatalog = { identities: [], pools: [], sites: [] };
/** 持久状态只有元数据和私有文件引用，不能包含令牌正文。 */
interface SettingsRow {
  revision: number;
  mode: 'environment' | 'local' | 'http';
  catalog: IdentityCatalog | null;
  url: string | null;
  token_id: string | null;
  updated_at: Date;
}
/** 编辑版本防止多人覆盖；令牌省略仅允许保留同一 URL 的既有令牌。 */
type SettingsWrite =
  | { revision: number; mode: 'environment' }
  | { revision: number; mode: 'local'; catalog: IdentityCatalog }
  | { revision: number; mode: 'http'; url: string; token?: string };

/** 只返回固定校验原因，避免第三方响应或输入中的秘密进入错误及日志。 */
function parseWrite(value: unknown): SettingsWrite {
  const invalid = (message: string): never => {
    throw new ApiError(400, 'INVALID_IDENTITY_SETTINGS', message);
  };
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return invalid('身份配置必须是对象');
  const v = value as Record<string, unknown>;
  const allowed =
    v.mode === 'http'
      ? ['revision', 'mode', 'url', 'token']
      : v.mode === 'local'
        ? ['revision', 'mode', 'catalog']
        : ['revision', 'mode'];
  if (
    Object.keys(v).some((key) => !allowed.includes(key)) ||
    !Number.isSafeInteger(v.revision) ||
    (v.revision as number) < 0
  )
    return invalid('配置版本或字段无效，请重新读取配置');
  if (v.mode === 'environment') return v as SettingsWrite;
  if (v.mode === 'local') {
    try {
      return {
        revision: v.revision as number,
        mode: 'local',
        catalog: validateCatalog(v.catalog),
      };
    } catch {
      return invalid(
        '身份、账号池或站点规则无效，请检查必填项、重复 ID、引用与核验条件',
      );
    }
  }
  if (v.mode !== 'http' || typeof v.url !== 'string' || v.url.length > 2048)
    return invalid('请选择配置来源并填写有效的外部库地址');
  let url: string;
  try {
    url = providerUrl(v.url);
  } catch {
    return invalid(
      '外部库地址须使用 HTTPS，不含用户名、密码、查询参数或片段；本机回环可用 HTTP',
    );
  }
  if (
    v.token !== undefined &&
    (typeof v.token !== 'string' ||
      !v.token.trim() ||
      /[^\x21-\x7e]/.test(v.token) ||
      Buffer.byteLength(v.token) > MAX_TOKEN_BYTES)
  )
    return invalid(
      '访问令牌须为不含空白的有效 Bearer 令牌，且不超过 8192 字节',
    );
  return {
    revision: v.revision as number,
    mode: 'http',
    url,
    ...(v.token === undefined ? {} : { token: v.token as string }),
  };
}

/** 页面配置与 case 准入共用唯一读取源；既有任务使用已冻结计划。 */
export class IdentitySettings {
  /** 每个保存版本单独缓存提供方，旧请求不会写回新版本缓存。 */
  private cached:
    { revision: number; provider: HttpCatalogProvider } | undefined;
  /** 部署默认值独立保留，切回后继续读取原有文件或外部提供方。 */
  private readonly deployment: HttpCatalogProvider | undefined;
  /** 私有目录随证据卷持久化，但不注册成可下载证据。 */
  private readonly directory: string;
  constructor(
    private readonly db: Database,
    private readonly config: ApiConfig,
  ) {
    this.deployment = config.identityProvider
      ? new HttpCatalogProvider(config.identityProvider)
      : undefined;
    this.directory =
      config.identitySecretDirectory ??
      join(config.artifactDirectory, '.identity-secrets');
  }

  /** GET 配置不请求外部服务；连接故障时页面仍可读取和修正。 */
  private async row(): Promise<SettingsRow> {
    return (
      await this.db.query<SettingsRow>(
        'SELECT * FROM pr_identity_settings WHERE singleton=true',
      )
    ).rows[0]!;
  }

  /** 外部目录只读；部署文件的路径和私有令牌永不回显。 */
  async view() {
    return this.project(await this.row());
  }

  /** 同一目录响应的版本与内容必须来自同一配置快照，避免并发保存后混用来源。 */
  private project(row: SettingsRow) {
    return {
      revision: row.revision,
      mode: row.mode,
      updatedAt: row.updated_at,
      source:
        row.mode === 'http' || (row.mode === 'environment' && this.deployment)
          ? 'http'
          : 'local',
      url:
        row.mode === 'http'
          ? row.url
          : row.mode === 'environment'
            ? (this.config.identityProvider?.url ?? null)
            : null,
      tokenConfigured:
        row.mode === 'http'
          ? !!row.token_id
          : row.mode === 'environment' && !!this.deployment,
      catalog:
        row.mode === 'local'
          ? row.catalog
          : row.mode === 'environment' && !this.deployment
            ? (this.config.identityCatalog ?? EMPTY)
            : null,
    };
  }

  /** 用随机服务端引用拼接路径，页面无法指定文件名或读取任意私有文件。 */
  private provider(row: SettingsRow): HttpCatalogProvider | undefined {
    if (row.mode === 'environment') return this.deployment;
    if (row.mode !== 'http') return undefined;
    if (this.cached?.revision !== row.revision)
      this.cached = {
        revision: row.revision,
        provider: new HttpCatalogProvider({
          url: row.url!,
          tokenFile: join(this.directory, row.token_id!),
        }),
      };
    return this.cached.provider;
  }

  /** 新 case 和管理员读取使用同一热配置，不修改正在执行的任务定义。 */
  async catalog(refresh = false): Promise<IdentityCatalog> {
    return this.readCatalog(await this.row(), refresh);
  }

  /** 管理员目录读取与 case 准入共用解析逻辑。 */
  async snapshot() {
    const row = await this.row();
    return {
      ...this.project(row),
      catalog: await this.readCatalog(row, false),
    };
  }

  /** 在一个配置版本内完成读取；外部不可用时不伪装为空目录。 */
  private async readCatalog(
    row: SettingsRow,
    refresh: boolean,
  ): Promise<IdentityCatalog> {
    const provider = this.provider(row);
    if (provider) return provider.get(refresh);
    return structuredClone(
      row.mode === 'local'
        ? row.catalog!
        : (this.config.identityCatalog ?? EMPTY),
    );
  }

  /** 修改 URL 必须重填令牌，不能把保存的秘密转发给另一个服务。 */
  private secret(
    input: Extract<SettingsWrite, { mode: 'http' }>,
    row: SettingsRow,
  ): string {
    if (input.token) return input.token;
    if (row.mode !== 'http' || row.url !== input.url || !row.token_id)
      throw new ApiError(
        400,
        'IDENTITY_TOKEN_REQUIRED',
        '新连接或修改地址时请重新填写访问令牌',
      );
    try {
      return readProviderToken(join(this.directory, row.token_id));
    } catch {
      throw new ApiError(
        503,
        'IDENTITY_TOKEN_UNAVAILABLE',
        '已保存令牌不可读取，请重新填写后保存',
      );
    }
  }

  /** 验证仅访问元数据接口，不发起真实登录或占用测试账号。 */
  private async validate(input: SettingsWrite, row: SettingsRow) {
    if (input.revision !== row.revision)
      throw new ApiError(
        409,
        'IDENTITY_SETTINGS_CONFLICT',
        '配置已被其他操作修改，请重新读取后编辑',
      );
    if (input.mode === 'local') return input.catalog;
    if (input.mode === 'environment')
      return this.deployment
        ? this.deployment.get(true)
        : (this.config.identityCatalog ?? EMPTY);
    const secret = this.secret(input, row);
    return new HttpCatalogProvider({
      url: input.url,
      readToken: () => secret,
    }).get();
  }

  /** 草稿验证不会写文件、更新版本或改变调度使用的目录。 */
  async test(value: unknown) {
    const input = parseWrite(value);
    const catalog = await this.validate(input, await this.row());
    return {
      identities: catalog.identities.length,
      pools: catalog.pools.length,
      sites: catalog.sites.length,
    };
  }

  /** 外部连接先验证，文件以随机名独占创建，再通过版本比较原子发布配置。 */
  async save(value: unknown) {
    const input = parseWrite(value);
    const row = await this.row();
    // 恢复部署默认值不依赖外部服务可用；其他模式必须先验证目录。
    if (input.mode !== 'environment') await this.validate(input, row);
    let tokenId = input.mode === 'http' ? row.token_id : null;
    let created: string | undefined;
    if (input.mode === 'http' && input.token) {
      tokenId = randomUUID();
      created = join(this.directory, tokenId);
      try {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const stat = await lstat(this.directory);
        if (!stat.isDirectory() || (stat.mode & 0o077) !== 0)
          throw new Error('private directory required');
        await writeFile(created, input.token, { flag: 'wx', mode: 0o600 });
      } catch {
        throw new ApiError(
          503,
          'IDENTITY_SECRET_STORAGE',
          '令牌未保存：请检查服务端身份私有目录的持久化与访问权限',
        );
      }
    }
    const result = await this.db.query(
      `UPDATE pr_identity_settings SET revision=revision+1,mode=$2,catalog=$3,url=$4,token_id=$5,updated_at=clock_timestamp() WHERE singleton=true AND revision=$1 RETURNING revision`,
      [
        input.revision,
        input.mode,
        input.mode === 'local' ? JSON.stringify(input.catalog) : null,
        input.mode === 'http' ? input.url : null,
        tokenId,
      ],
    );
    // 数据库结果未知时保留新文件供当前配置恢复，不根据网络错误猜测事务回滚。
    if (!result.rowCount) {
      if (created) await unlink(created).catch(() => {});
      throw new ApiError(
        409,
        'IDENTITY_SETTINGS_CONFLICT',
        '配置已被其他操作修改，请重新读取后编辑',
      );
    }
    if (row.token_id && row.token_id !== tokenId)
      await unlink(join(this.directory, row.token_id)).catch(() => {});
    return this.view();
  }
}
