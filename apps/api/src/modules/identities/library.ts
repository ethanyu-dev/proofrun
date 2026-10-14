import { fallbackLibraryIdentity } from './slot.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  NodeCommand,
  SessionPlan,
  VerificationTask,
} from '@proofrun/contracts';
import type { Database } from '../../db.js';
import type { ApiConfig } from '../../config.js';
import { ApiError } from '../../domain.js';
import type { IdentityCatalog } from './catalog.js';

/** Cookie 只允许当前站点的封闭格式；错误不包含用户输入的秘密。 */
const NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** Cookie 值使用请求头允许的 ASCII 范围，拒绝换行与分隔符注入。 */
const VALUE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/;
/** 页面只回传服务端生成的内部引用，不接受目录路径。 */
const ID = /^[a-f0-9-]{36}$/;
type Seed = NonNullable<
  Extract<NodeCommand['command'], { type: 'session.open' }>['identitySeed']
>;
/** 页面返回内部修订号用于并发保存，但不返回 Cookie 值或服务器路径。 */
export interface LibraryIdentity {
  /** 系统生成的稳定账号引用，编辑和人工更新不改变。 */
  id: string;
  /** 页面乐观锁版本，避免覆盖另一位用户的修改。 */
  revision: number;
  /** Cookie 种子及完整基准的版本，独立于页面修订。 */
  version: string;
  /** 限定 Cookie 主机与候选站点的测试地址。 */
  url: string;
  /** 页面与选择 Agent 使用的身份名称。 */
  name: string;
  /** 可选角色提示，不作为实际权限证明。 */
  identity_type: string;
  /** 描述团队和权限等选取条件，不包含登录秘密。 */
  description: string;
  /** 全局活跃账号会话上限，待关闭会话仍占用。 */
  concurrency: number;
  /** API 私有种子文件的随机引用，永不返回客户端。 */
  cookie_file: string | null;
  /** 成功人工基准所属节点，完整 profile 不跨节点搬运。 */
  baseline_node: string | null;
}

/** 支持 JSON Cookie 数组或请求头格式；协议限定 host-only、根路径 Cookie。 */
export function parseIdentityCookies(raw: unknown): Seed['cookies'] {
  const invalid = () =>
    new ApiError(
      422,
      'INVALID_IDENTITY_COOKIES',
      'Cookies 格式无效，请填写 JSON 数组或 name=value; name=value',
    );
  if (typeof raw !== 'string' || raw.length > 150_000) throw invalid();
  let entries: unknown;
  try {
    entries = raw.trim().startsWith('[')
      ? JSON.parse(raw)
      : raw
          .split(';')
          .filter((v) => v.trim())
          .map((value) => {
            const index = value.indexOf('=');
            if (index < 1) throw invalid();
            return {
              name: value.slice(0, index).trim(),
              value: value.slice(index + 1).trim(),
              httpOnly: true,
            };
          });
  } catch {
    throw invalid();
  }
  if (!Array.isArray(entries) || entries.length > 32) throw invalid();
  const seen = new Set<string>();
  return entries.map((entry) => {
    if (
      !entry ||
      typeof entry !== 'object' ||
      Object.keys(entry).some(
        (k) => !['name', 'value', 'httpOnly'].includes(k),
      ) ||
      typeof entry.name !== 'string' ||
      !NAME.test(entry.name) ||
      entry.name.length > 256 ||
      seen.has(entry.name) ||
      typeof entry.value !== 'string' ||
      !VALUE.test(entry.value) ||
      entry.value.length > 4096 ||
      (entry.httpOnly !== undefined && typeof entry.httpOnly !== 'boolean')
    )
      throw invalid();
    seen.add(entry.name);
    return {
      name: entry.name,
      value: entry.value,
      httpOnly: entry.httpOnly ?? true,
    };
  });
}

/** 页面管理目录；凭据文件与旧版本独立保留，冻结任务只按版本读取。 */
export class IdentityLibrary {
  private readonly directory: string;
  constructor(
    private readonly db: Database,
    config: ApiConfig,
  ) {
    this.directory = join(
      config.identitySecretDirectory ??
        join(config.artifactDirectory, '.identity-secrets'),
      'library',
    );
  }
  /** 页面只取得六字段及是否已配置的摘要，不读取秘密文件。 */
  async list() {
    const rows = await this.db.query<LibraryIdentity>(
      'SELECT * FROM pr_identity_library WHERE NOT deleted ORDER BY updated_at DESC,id',
    );
    return {
      identities: rows.rows.map((row) => ({
        id: row.id,
        revision: row.revision,
        url: row.url,
        name: row.name,
        type: row.identity_type,
        description: row.description,
        concurrency: row.concurrency,
        cookiesConfigured: !!row.cookie_file,
        baselineReady: !!row.baseline_node,
      })),
    };
  }
  /** 内部候选只有元数据，Cookie 与 profile 内容不会进入冻结定义。 */
  async catalog(): Promise<IdentityCatalog> {
    const rows = await this.db.query<LibraryIdentity>(
      'SELECT * FROM pr_identity_library WHERE NOT deleted ORDER BY id LIMIT 256',
    );
    return {
      selectionEnabled: true,
      identities: rows.rows.map((row) => ({
        id: row.id,
        label: row.name,
        accountKey: row.id,
        origins: [new URL(row.url).origin],
        checks: [],
        maxConcurrent: row.concurrency,
        libraryVersion: row.version,
        description: row.description,
        identityType: row.identity_type,
        url: row.url,
        ...(row.baseline_node
          ? {
              nodeId: row.baseline_node,
              stateId: `lib-${row.id}-${row.version}`,
            }
          : {}),
      })),
      pools: [],
      sites: [],
    };
  }
  /** 保存六个用户字段；只有地址或 Cookie 改变时才使原 profile 基准失效。 */
  async save(raw: unknown) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new ApiError(422, 'INVALID_IDENTITY', '身份信息无效');
    const input = raw as Record<string, unknown>;
    if (
      Object.keys(input).some(
        (k) =>
          ![
            'id',
            'revision',
            'url',
            'name',
            'type',
            'description',
            'concurrency',
            'cookies',
          ].includes(k),
      )
    )
      throw new ApiError(422, 'INVALID_IDENTITY', '身份包含未知字段');
    for (const key of ['url', 'name', 'description'])
      if (
        typeof input[key] !== 'string' ||
        !input[key].trim() ||
        input[key].length > (key === 'name' ? 160 : 2000)
      )
        throw new ApiError(
          422,
          'INVALID_IDENTITY',
          '请填写测试地址、身份名称和身份描述',
        );
    let url: URL;
    try {
      url = new URL(input.url as string);
    } catch {
      throw new ApiError(422, 'INVALID_IDENTITY', '测试地址无效');
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      !Number.isInteger(input.concurrency) ||
      Number(input.concurrency) < 1 ||
      Number(input.concurrency) > 32 ||
      (input.type !== undefined &&
        (typeof input.type !== 'string' || input.type.length > 100)) ||
      (input.id !== undefined &&
        (typeof input.id !== 'string' || !ID.test(input.id)))
    )
      throw new ApiError(422, 'INVALID_IDENTITY', '身份字段格式无效');
    const id = (input.id as string | undefined) ?? randomUUID();
    const cookies =
      input.cookies === undefined || input.cookies === ''
        ? undefined
        : parseIdentityCookies(input.cookies);
    const file = cookies ? randomUUID() : null;
    if (file) {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await writeFile(join(this.directory, file), JSON.stringify(cookies), {
        mode: 0o600,
        flag: 'wx',
      });
    }
    // 文件先落盘；提交结果不明时保留，不能删除可能已被冻结任务引用的凭据。
    await this.db.transaction(async (client) => {
      const old = (
        await client.query<LibraryIdentity>(
          'SELECT * FROM pr_identity_library WHERE id=$1 AND NOT deleted FOR UPDATE',
          [id],
        )
      ).rows[0];
      if (input.id && (!old || input.revision !== old.revision))
        throw new ApiError(
          409,
          'IDENTITY_REVISION_CONFLICT',
          '身份已被修改，请重新读取后保存',
        );
      if (
        !old &&
        (
          await client.query(
            'SELECT 1 FROM pr_identity_library WHERE NOT deleted OFFSET 255 LIMIT 1',
          )
        ).rowCount
      )
        throw new ApiError(422, 'IDENTITY_LIMIT', '最多维护 256 个身份');
      const changed = !old || !!file || old.url !== url.href;
      const version = changed ? randomUUID() : old.version;
      const cookieFile = file ?? old?.cookie_file ?? null;
      if (changed)
        await client.query(
          'INSERT INTO pr_identity_seeds(version,cookie_file) VALUES($1,$2)',
          [version, cookieFile],
        );
      await client.query(
        `INSERT INTO pr_identity_library(id,version,url,name,identity_type,description,concurrency,cookie_file) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO UPDATE SET revision=pr_identity_library.revision+1,version=$2,url=$3,name=$4,identity_type=$5,description=$6,concurrency=$7,cookie_file=$8,baseline_node=CASE WHEN pr_identity_library.version=$2 THEN pr_identity_library.baseline_node ELSE NULL END,updated_at=clock_timestamp()`,
        [
          id,
          version,
          url.href,
          (input.name as string).trim(),
          input.type ?? '',
          (input.description as string).trim(),
          input.concurrency,
          cookieFile,
        ],
      );
    });
    return this.list();
  }
  /** 软删除只影响新任务，保留冻结任务仍引用的版本。 */
  async remove(raw: unknown) {
    const input = raw as { id?: string; revision?: number } | null;
    if (
      !input ||
      typeof input.id !== 'string' ||
      !ID.test(input.id) ||
      !Number.isInteger(input.revision)
    )
      throw new ApiError(422, 'INVALID_IDENTITY', '身份引用无效');
    const result = await this.db.query(
      'UPDATE pr_identity_library SET deleted=true,revision=revision+1 WHERE id=$1 AND revision=$2 AND NOT deleted',
      [input.id, input.revision],
    );
    if (!result.rowCount)
      throw new ApiError(
        409,
        'IDENTITY_REVISION_CONFLICT',
        '身份已被修改，请刷新后重试',
      );
    return this.list();
  }
  /** 投递时读取冻结版本；缺失配方返回空种子，由执行器交给人工，禁止泄漏异常正文。 */
  async seed(identity: SessionPlan['candidates'][number]): Promise<Seed> {
    const row = (
      await this.db.query<{ cookie_file: string | null }>(
        'SELECT cookie_file FROM pr_identity_seeds WHERE version=$1',
        [identity.libraryVersion],
      )
    ).rows[0];
    let cookies: Seed['cookies'] = [];
    if (row?.cookie_file) {
      try {
        cookies = parseIdentityCookies(
          await readFile(join(this.directory, row.cookie_file), 'utf8'),
        );
      } catch {
        /* 缺失凭据不阻止人工准备浏览器。 */
      }
    }
    return { url: identity.url ?? identity.origins[0]!, cookies };
  }
  /** 只有人工成功保存基准后登记归属；旧版本不能覆盖页面刚修改的 Cookie。 */
  async published(taskId: string, nodeId: string) {
    const row = (
      await this.db.query<{
        identity: SessionPlan['candidates'][number] | null;
        definition: VerificationTask;
      }>(
        'SELECT a.identity,t.definition FROM pr_tasks t LEFT JOIN pr_identity_assignments a ON a.task_id=t.id WHERE t.id=$1',
        [taskId],
      )
    ).rows[0];
    const identity =
      row?.identity ??
      (row?.definition.sessionPlan?.library
        ? fallbackLibraryIdentity(row.definition)
        : undefined);
    if (!identity?.libraryVersion) return;
    await this.db.query(
      `INSERT INTO pr_identity_library(id,version,url,name,identity_type,description,concurrency,baseline_node) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO UPDATE SET baseline_node=$8,updated_at=clock_timestamp() WHERE pr_identity_library.version=$2 AND NOT pr_identity_library.deleted`,
      [
        identity.id,
        identity.libraryVersion,
        identity.url ?? identity.origins[0],
        identity.label,
        identity.identityType ?? '',
        identity.description ?? '人工准备的测试身份',
        identity.maxConcurrent,
        nodeId,
      ],
    );
  }
}
