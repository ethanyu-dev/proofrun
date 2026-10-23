import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { compactDecrypt, importPKCS8 } from 'jose';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  normalizeOrigin,
  validate,
  validateMaterial,
  type GetAccountInput,
  type GetAccountOutput,
  type ReleaseAccountInput,
  type ReleaseAccountOutput,
  type Material,
  type MaterialPayload,
} from '@dev-pass/contracts';

/** MCP 建连与请求超时不占用控制面事件循环。 */
const TRANSPORT_TIMEOUT_MS = 10_000;

type Allocated = Extract<GetAccountOutput, { status: 'allocated' }>;
/** 账本不保存原始材料与私钥；请求与释放意图先落盘，以便响应丢失后恢复。 */
export interface JournalEntry {
  /** 首次获取的原始参数，用于重启后使用相同业务请求恢复。 */
  request: GetAccountInput;
  /** 分配响应一旦收到就持久化，解密失败也不能丢失该占用。 */
  lease_id?: string;
  /** 服务端截止时间，客户端不得通过重启或重试延长。 */
  expires_at?: string;
  /** 本地恢复阶段；不替代服务端租约状态。 */
  state: 'requested' | 'allocated' | 'release_pending' | 'stopped' | 'released';
  /** 已刷盘的回报意图；停止确认后的终态参数不能修改。 */
  release?: ReleaseAccountInput;
}
/** 可替换文件账本的持久存储；调用方须保证同一账本只有一个写入者。 */
export interface JournalStore {
  /** 读取已提交的申请与释放意图，禁止包含认证材料。 */
  load(): Promise<Record<string, JournalEntry>>;
  /** 在发送外部请求前可靠提交完整账本。 */
  save(entries: Record<string, JournalEntry>): Promise<void>;
}
export interface ClientOptions {
  /** HTTPS MCP 地址；本地开发可以显式允许回环 HTTP。 */
  url: string;
  /** 调用方访问凭据，仅作为 HTTP 认证头。 */
  token: string;
  /** 与服务端登记身份一致，用于核验 JWE 接收方绑定。 */
  clientId: string;
  /** 接收公钥对应的 PKCS8 私钥，不发送给平台。 */
  privateKeyPem?: string;
  /** 按租约冻结的 key ID 解析密钥，以支持旧租约跨越密钥轮换。 */
  resolvePrivateKey?: (keyId: string) => Promise<string>;
  /** 每个进程独占的持久化账本路径。 */
  journalFile?: string;
  /** 数据库部署使用此端口，不与文件账本同时配置。 */
  journalStore?: JournalStore;
  /** 只允许开发夹具的回环 HTTP，不放宽其他 origin。 */
  allowLoopback?: boolean;
}

/** 私有材料不参与 JSON 序列化，模型只能接收 publicAccount() 的投影。 */
export class AccountLease {
  #material: Material | undefined;
  #closed = false;
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  constructor(
    readonly result: Allocated,
    material: Material,
  ) {
    this.#material = material;
    this.timer = setTimeout(
      () => this.controller.abort(new Error('账号租约到期')),
      Math.max(0, Date.parse(result.lease.expires_at) - Date.now() - 1000),
    );
    this.timer.unref();
  }
  get signal() {
    return this.controller.signal;
  }
  /** 到期信号用于停止执行，不表示远端浏览器已经关闭。 */
  async useMaterial<T>(
    consumer: (material: Material, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (
      !this.#material ||
      this.#closed ||
      this.signal.aborted ||
      Date.parse(this.result.lease.expires_at) <= Date.now()
    )
      throw new Error('租约不可继续使用');
    return consumer(this.#material, this.signal);
  }
  publicAccount() {
    const { material, ...account } = this.result.account;
    return { account, lease: this.result.lease, material_type: material.type };
  }
  close() {
    this.#material = undefined;
    this.#closed = true;
    clearTimeout(this.timer);
    this.controller.abort();
  }
}

/** 一个实例独占一个账本文件；不同进程应使用不同路径，外层负责资源实际清理。 */
export class DevPassClient {
  private readonly client = new Client({
    name: 'dev-pass-client',
    version: '0.1.0',
  });
  private entries: Record<string, JournalEntry> = Object.create(null);
  private writing: Promise<void> = Promise.resolve();
  private constructor(private readonly options: ClientOptions) {}
  static async connect(options: ClientOptions) {
    const url = new URL(options.url);
    normalizeOrigin(url.origin, options.allowLoopback);
    if (url.username || url.password || url.hash || url.search)
      throw new Error('MCP URL 无效');
    if (!options.journalFile === !options.journalStore)
      throw new Error('必须且只能配置一个持久账本');
    if (!options.privateKeyPem && !options.resolvePrivateKey)
      throw new Error('必须配置接收密钥');
    const instance = new DevPassClient(options);
    try {
      instance.entries = Object.assign(
        Object.create(null),
        options.journalStore
          ? await options.journalStore.load()
          : JSON.parse(await readFile(options.journalFile!, 'utf8')),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await instance.client.connect(
      new StreamableHTTPClientTransport(url, {
        // 每次网络请求单独计时，不能让长生命周期客户端在建连十秒后永久失效。
        fetch: (input, init) =>
          fetch(input, {
            ...init,
            signal: AbortSignal.any([
              ...(init?.signal ? [init.signal] : []),
              AbortSignal.timeout(TRANSPORT_TIMEOUT_MS),
            ]),
          }),
        requestInit: {
          headers: { authorization: 'Bearer ' + options.token },
          redirect: 'error',
        },
      }),
    );
    return instance;
  }
  private persist(): Promise<void> {
    const snapshot = structuredClone(this.entries);
    const content = JSON.stringify(snapshot);
    this.writing = this.writing.then(async () => {
      if (this.options.journalStore) {
        await this.options.journalStore.save(snapshot);
        return;
      }
      await mkdir(dirname(this.options.journalFile!), {
        recursive: true,
        mode: 0o700,
      });
      const temp = this.options.journalFile! + '.' + randomUUID() + '.tmp';
      // 文件与目录均刷盘后才继续网络请求，避免只完成 rename 就误认为意图已持久化。
      const file = await open(temp, 'wx', 0o600);
      try {
        await file.writeFile(content);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temp, this.options.journalFile!);
      const directory = await open(dirname(this.options.journalFile!), 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    });
    return this.writing;
  }
  pending(): JournalEntry[] {
    return structuredClone(
      Object.values(this.entries).filter((entry) => entry.state !== 'released'),
    );
  }
  async getAccount(
    input: GetAccountInput,
  ): Promise<AccountLease | Exclude<GetAccountOutput, Allocated>> {
    validate('getInput', input);
    const prior = this.entries[input.request_id];
    if (
      prior?.state === 'released' ||
      prior?.state === 'stopped' ||
      prior?.state === 'release_pending'
    )
      throw new Error('本地租约已停止，不得重新启用');
    if (prior && JSON.stringify(prior.request) !== JSON.stringify(input))
      throw new Error('本地请求 ID 参数发生变化');
    if (!prior)
      this.entries[input.request_id] = {
        request: structuredClone(input),
        /** 本地恢复阶段；不替代服务端租约状态。 */
        state: 'requested',
      };
    await this.persist();
    const response = await this.client.callTool(
      {
        name: 'getAccount',
        arguments: { ...input },
      },
      undefined,
      { timeout: TRANSPORT_TIMEOUT_MS },
    );
    const result = response.structuredContent;
    validate('getOutput', result);
    const data = result as GetAccountOutput;
    if (data.status !== 'allocated') return data;
    this.entries[input.request_id] = {
      request: structuredClone(input),
      lease_id: data.lease.id,
      expires_at: data.lease.expires_at,
      state: 'allocated',
    };
    await this.persist();
    const pem = this.options.resolvePrivateKey
      ? await this.options.resolvePrivateKey(
          data.account.material.delivery.recipient_key_id,
        )
      : this.options.privateKeyPem!;
    const key = await importPKCS8(pem, 'RSA-OAEP-256');
    const decoded = await compactDecrypt(
      data.account.material.delivery.ciphertext,
      key,
      {
        keyManagementAlgorithms: ['RSA-OAEP-256'],
        contentEncryptionAlgorithms: ['A256GCM'],
      },
    );
    const payload = JSON.parse(
      new TextDecoder().decode(decoded.plaintext),
    ) as MaterialPayload;
    validate('payload', payload);
    if (
      decoded.protectedHeader.kid !==
        data.account.material.delivery.recipient_key_id ||
      decoded.protectedHeader.typ !== 'devpass-material+jwe' ||
      payload.recipient_id !== this.options.clientId ||
      payload.lease_id !== data.lease.id ||
      payload.account_id !== data.account.id ||
      payload.material_version !== data.account.material.version ||
      payload.origin !== data.account.origin ||
      payload.origin !==
        normalizeOrigin(input.origin, this.options.allowLoopback) ||
      data.account.platform !== input.platform ||
      (input.account_id !== undefined &&
        input.account_id !== data.account.id) ||
      !input.accepted_material_types.includes(data.account.material.type) ||
      (input.role_description ?? []).some(
        (role) => !data.account.role_description.includes(role.trim()),
      ) ||
      payload.use_before !== data.lease.expires_at ||
      payload.material.type !== data.account.material.type ||
      Date.parse(payload.use_before) <= Date.now()
    )
      throw new Error('材料与当前租约不匹配');
    validateMaterial(payload.material, payload.origin);
    return new AccountLease(data, payload.material);
  }
  /** closeResources 必须确认实际执行资源停止；失败时保留账本，不伪造释放成功。 */
  async releaseAccount(
    lease: AccountLease,
    closeResources: () => Promise<void>,
    outcome: ReleaseAccountInput['outcome'] = 'completed',
    note = '',
  ): Promise<ReleaseAccountOutput> {
    lease.close();
    try {
      await closeResources();
    } catch (error) {
      // 停止失败仍上报待释放；网络失败时账本保留意图，不能伪造停止成功。
      try {
        await this.reportNotStopped(
          lease.result.lease.id,
          'execution_error',
          '执行资源停止未获确认',
        );
      } catch {
        /* 原始关闭错误交给编排层，后续从账本恢复。 */
      }
      throw error;
    }
    return this.releaseStopped(lease.result.lease.id, outcome, note);
  }
  /** 无法确认资源停止时报告待释放；该方法永远不会主动减少服务端占用。 */
  async reportNotStopped(
    leaseId: string,
    outcome: ReleaseAccountInput['outcome'],
    note = '',
  ): Promise<ReleaseAccountOutput> {
    const entry = Object.values(this.entries).find(
      (item) => item.lease_id === leaseId,
    );
    if (!entry || entry.state === 'released' || entry.state === 'stopped')
      throw new Error('本地租约不可回退为待停止');
    const input: ReleaseAccountInput = {
      lease_id: leaseId,
      usage_stopped: false,
      outcome,
      note,
    };
    entry.release = input;
    entry.state = 'release_pending';
    await this.persist();
    const response = await this.client.callTool(
      {
        name: 'releaseAccount',
        arguments: { ...input },
      },
      undefined,
      { timeout: TRANSPORT_TIMEOUT_MS },
    );
    validate('releaseOutput', response.structuredContent);
    // 即使管理员已回收，也保留本地待停止状态，要求编排层继续核实自己的执行资源。
    return response.structuredContent as ReleaseAccountOutput;
  }
  /** 仅在执行资源确已停止后调用；已持久化的最终回报在重试中保持不变。 */
  async releaseStopped(
    leaseId: string,
    outcome: ReleaseAccountInput['outcome'],
    note = '',
  ): Promise<ReleaseAccountOutput> {
    const entry = Object.values(this.entries).find(
      (item) => item.lease_id === leaseId,
    );
    if (!entry) throw new Error('账本中没有该租约');
    const input = entry.release?.usage_stopped
      ? entry.release
      : {
          lease_id: leaseId,
          usage_stopped: true,
          outcome,
          note,
        };
    entry.release = input;
    entry.state = 'stopped';
    await this.persist();
    const response = await this.client.callTool(
      {
        name: 'releaseAccount',
        arguments: { ...input },
      },
      undefined,
      { timeout: TRANSPORT_TIMEOUT_MS },
    );
    validate('releaseOutput', response.structuredContent);
    const result = response.structuredContent as ReleaseAccountOutput;
    if (result.status === 'released') {
      entry.state = 'released';
      await this.persist();
    }
    return result;
  }
  /** 关闭 MCP 连接不会释放账号；必须先由调用方确认资源停止并交还。 */
  async disconnect() {
    await this.writing;
    await this.client.close();
  }
}
