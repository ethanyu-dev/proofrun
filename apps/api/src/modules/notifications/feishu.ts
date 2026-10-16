/** 固定官方入口，部署配置不能把应用秘密发送到任意地址。 */
const API_ORIGIN = 'https://open.feishu.cn';
/** 单次 HTTP 总时限；通知线程与业务调度隔离。 */
const REQUEST_MS = 5000;
/** 提前刷新访问令牌，减少临界时刻失败。 */
const TOKEN_MARGIN_MS = 60_000;
/** 消息发送和更新共用的访问令牌失效业务码。 */
const TOKEN_ERRORS = new Set([99991663, 99991664, 99991668]);
/** 被撤回、过期或删除的卡片不能再更新。 */
const UNEDITABLE_ERRORS = new Set([230011, 230031, 230110]);
/** 应用、群与消息身份只接受飞书定义的安全路径字符。 */
const APP_ID = /^cli_[A-Za-z0-9]+$/;
const CHAT_ID = /^oc_[A-Za-z0-9]+$/;
const MESSAGE_ID = /^om_[A-Za-z0-9_-]+$/;

/** 企业自建应用的服务端配置，不下发到 Console 或 Agent。 */
export interface FeishuConfig {
  /** 已发布且开启机器人能力的自建应用。 */
  appId: string;
  /** 仅用于交换 tenant_access_token，不持久化到消息表。 */
  appSecret: string;
  /** 已加入此应用机器人的目标群。 */
  chatId: string;
}

/** 三个字段必须同时配置；全空表示关闭，报错不带任何配置值。 */
export function feishuConfig(
  appId?: string,
  appSecret?: string,
  chatId?: string,
): FeishuConfig | undefined {
  const values = [
    appId?.trim() ?? '',
    appSecret?.trim() ?? '',
    chatId?.trim() ?? '',
  ];
  if (values.every((value) => !value)) return undefined;
  if (!APP_ID.test(values[0]!) || !values[1] || !CHAT_ID.test(values[2]!))
    throw new Error(
      '请同时正确配置 PROOFRUN_FEISHU_APP_ID、PROOFRUN_FEISHU_APP_SECRET 和 PROOFRUN_FEISHU_CHAT_ID',
    );
  return { appId: values[0]!, appSecret: values[1]!, chatId: values[2]! };
}

/** 只保留可诊断的数值码，外部响应正文、请求 URL、密钥及卡片内容不得进入日志。 */
export class FeishuError extends Error {
  constructor(
    /** 飞书业务码；网络故障或无法解析响应时为零。 */
    readonly code = 0,
    /** HTTP 状态；没有收到响应时为零。 */
    readonly status = 0,
  ) {
    super(`飞书通知请求失败（HTTP ${status}，业务码 ${code}）`);
  }
  /** 仅用于停止不可恢复的旧卡片更新，不影响后续事件发送。 */
  get uneditable(): boolean {
    return UNEDITABLE_ERRORS.has(this.code);
  }
}

/** 发送返回消息 ID；更新只操作相同应用发送的共享卡片。 */
export interface FeishuTransport {
  send(card: object, uuid: string, signal: AbortSignal): Promise<string>;
  update(messageId: string, card: object, signal: AbortSignal): Promise<void>;
}

/** 缓存应用访问令牌；每个实例只对应固定应用和目标群。 */
export class FeishuClient implements FeishuTransport {
  /** 访问令牌只留在进程内存。 */
  private token: { value: string; expiresAt: number } | undefined;
  /** 并发请求合并刷新，不能为每张卡片反复交换令牌。 */
  private refreshing: Promise<string> | undefined;
  constructor(
    private readonly config: FeishuConfig,
    private readonly request: typeof fetch = fetch,
  ) {}

  /** 禁止重定向，防止携带应用身份的请求被转发；同时校验 HTTP 与业务码。 */
  private async json(
    path: string,
    body: object,
    signal: AbortSignal,
    token?: string,
    method = 'POST',
  ): Promise<Record<string, any>> {
    try {
      const response = await this.request(`${API_ORIGIN}${path}`, {
        method,
        redirect: 'error',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_MS)]),
      });
      const result: unknown = await response.json();
      const code =
        result &&
        typeof result === 'object' &&
        'code' in result &&
        typeof result.code === 'number'
          ? result.code
          : -1;
      if (!response.ok || code !== 0)
        throw new FeishuError(code, response.status);
      return result as Record<string, any>;
    } catch (error) {
      throw error instanceof FeishuError ? error : new FeishuError();
    }
  }

  /** 令牌到期前刷新；刷新失败不能继续使用已过期令牌。 */
  private accessToken(signal: AbortSignal): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now())
      return Promise.resolve(this.token.value);
    if (!this.refreshing)
      this.refreshing = this.json(
        '/open-apis/auth/v3/tenant_access_token/internal',
        {
          app_id: this.config.appId,
          app_secret: this.config.appSecret,
        },
        signal,
      )
        .then((result) => {
          if (
            typeof result.tenant_access_token !== 'string' ||
            !result.tenant_access_token ||
            !Number.isFinite(result.expire) ||
            result.expire <= 0
          )
            throw new FeishuError();
          this.token = {
            value: result.tenant_access_token,
            expiresAt:
              Date.now() + Math.max(0, result.expire * 1000 - TOKEN_MARGIN_MS),
          };
          return this.token.value;
        })
        .finally(() => {
          this.refreshing = undefined;
        });
    return this.refreshing;
  }

  /** 提前撤销的令牌只立即刷新一次；其他错误交由持久队列退避。 */
  private async authorized(
    path: string,
    body: object,
    signal: AbortSignal,
    method = 'POST',
  ) {
    for (let attempt = 0; ; attempt++) {
      const token = await this.accessToken(signal);
      try {
        return await this.json(path, body, signal, token, method);
      } catch (error) {
        if (
          attempt > 0 ||
          !(error instanceof FeishuError) ||
          (error.status !== 401 && !TOKEN_ERRORS.has(error.code))
        )
          throw error;
        if (this.token?.value === token) this.token = undefined;
      }
    }
  }

  /** 固定 uuid 和卡片内容重试，利用飞书一小时窗口避免重复发送。 */
  async send(card: object, uuid: string, signal: AbortSignal): Promise<string> {
    const result = await this.authorized(
      '/open-apis/im/v1/messages?receive_id_type=chat_id',
      {
        receive_id: this.config.chatId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
        uuid,
      },
      signal,
    );
    const id: unknown = result.data?.message_id;
    if (typeof id !== 'string' || !MESSAGE_ID.test(id)) throw new FeishuError();
    return id;
  }

  /** 内容始终完整替换，移除失效操作按钮；不通过卡片回调更改业务状态。 */
  async update(
    messageId: string,
    card: object,
    signal: AbortSignal,
  ): Promise<void> {
    if (!MESSAGE_ID.test(messageId)) throw new FeishuError();
    await this.authorized(
      `/open-apis/im/v1/messages/${messageId}`,
      { content: JSON.stringify(card) },
      signal,
      'PATCH',
    );
  }
}
