/* 根据 contracts/schemas 自动生成，请勿手改；修改 Schema 后运行 pnpm contracts:generate。 */

/**
 * 内部 worker 只能请求决策与提交一次结果，不接受浏览器命令或最终报告。
 */
export type RuntimeRequest =
  | {
      type: 'start';
      config: {
        model: string;
        vision: boolean;
        commandMs: number;
        evidenceMs: number;
        /**
         * 支持完整 V2 多步骤总额度；服务端仍按测试集固定预算核验，普通任务上限保持 200。
         */
        maxTurns: number;
        maxContextChars: number;
      };
    }
  | {
      type: 'decision';
      revision: number;
      outcome:
        | {
            output: {
              decision: AgentDecision;
              /**
               * @maxItems 3
               */
              additionalNetworkReads?:
                [] | [AgentDecision] | [AgentDecision, AgentDecision] | [AgentDecision, AgentDecision, AgentDecision];
              promptTokens: number;
              completionTokens: number;
            };
          }
        | {
            error: {
              code: string;
              status: number;
              /**
               * 仅允许 AgentFault 的安全业务反馈；禁止原始异常、供应商正文和密钥。
               */
              message?: string;
            };
          };
    }
  | {
      type: 'trace_start';
      revision: number;
      request: {
        model: string;
        purpose: 'DECISION';
        request: string;
        requestSha256: string;
        imagesOmitted: number;
        /**
         * 派发前计算的单次请求时限上限；存档后仍按剩余步骤期限收紧，不延长执行预算。
         */
        timeoutMs?: number;
      };
    }
  | {
      type: 'trace_finish';
      revision: number;
      result: {
        /**
         * worker 收到回复或错误的时间，未收到回执时为空。
         */
        finishedAt: string | null;
        /**
         * 仅表示请求接收状态，收到回复不等于模型决定有效或业务验收通过。
         */
        status: 'PENDING' | 'RECEIVED' | 'ERROR';
        /**
         * 供应商返回的 choices、answers、usage 等已选择字段 JSON，未接收或清理后为空。
         */
        response: string | null;
        /**
         * 稳定错误码，不保存带地址或凭据的原始异常文本。
         */
        error: string | null;
        /**
         * 供应商返回的输入用量，未报告则为空。
         */
        promptTokens: number | null;
        /**
         * 供应商返回的输出用量，未报告则为空。
         */
        completionTokens: number | null;
        /**
         * 一次供应商请求的耗时，不含记录交付。
         */
        elapsedMs: number | null;
        diagnostics?: Diagnostics;
      };
    };
/**
 * 模型提出的单步浏览器意图或逐项验收结果；平台补充身份并检查证据。
 */
export type AgentDecision =
  | {
      type: 'browser.observe';
      /**
       * 是否同时采集 PNG 截图；截图与 DOM 来自不同时间点。
       */
      screenshot?: boolean;
      progress?: Progress;
    }
  | {
      type: 'context.read';
      observationId: string;
      section: 'page' | 'runtime';
      /**
       * runtimeLists 中提供的列表路径；page 视图不填写。
       */
      path?: string;
      offset?: number;
      progress?: Progress;
    }
  | {
      type: 'network.request_detail';
      /**
       * 当前 page.network.observationId；分页与详情只读取该次快照。
       */
      observationId: string;
      progress?: Progress;
      /**
       * 从网络摘要列表获取的请求 ID。
       */
      requestId: string;
    }
  | {
      type: 'network.requests';
      /**
       * 当前 page.network.observationId；分页与详情只读取该次快照。
       */
      observationId: string;
      progress?: Progress;
      /**
       * 按已脱敏 URL 子串筛选，不是正则表达式。
       */
      urlContains?: string;
      /**
       * 按状态码筛选；null 表示未收到响应。
       */
      status?: number | null;
      /**
       * 筛选结果偏移；省略为 0，每页最多 20 条。
       */
      offset?: number;
    }
  | {
      type: 'browser.act';
      /**
       * 受限的浏览器动作；任一动作都可能产生业务副作用。
       */
      action:
        | 'navigate'
        | 'click'
        | 'fill'
        | 'press'
        | 'scroll'
        | 'hover'
        | 'check'
        | 'uncheck'
        | 'select'
        | 'type'
        | 'back'
        | 'forward'
        | 'reload'
        | 'frame'
        | 'tab.new'
        | 'tab.switch'
        | 'tab.close'
        | 'resize'
        | 'visual.click'
        | 'online'
        | 'pwa.cleanup'
        | 'network.probe';
      /**
       * 导航为 HTTP(S) URL；元素动作为当前观察 target；frame 为 iframe target 或 main；tab.switch/close 为已观察 tabId。
       */
      target?: string;
      /**
       * 填写/输入/选择的值、按键、滚动方向或 resize 的 WIDTHxHEIGHT。
       */
      value?: string;
      /**
       * visual.click 使用当前截图的视口 CSS 坐标。
       */
      x?: number;
      /**
       * visual.click 使用当前截图的视口 CSS 坐标。
       */
      y?: number;
      progress?: Progress;
      revisitReason?: string;
    }
  | {
      type: 'browser.wait';
      /**
       * 要匹配的 CSS 选择器；逐层搜索 open Shadow DOM 及同源 iframe。
       */
      selector: string;
      /**
       * 目标元素文本中必须包含的字符串。
       */
      text: string;
      progress?: Progress;
    }
  | FinishVerification
  | BlockVerification
  | RequestHumanAssistance
  | RecordVerification
  | {
      type: 'browser.cookies.clear';
      /**
       * @minItems 1
       * @maxItems 20
       */
      names:
        | [string]
        | [string, string]
        | [string, string, string]
        | [string, string, string, string]
        | [string, string, string, string, string]
        | [string, string, string, string, string, string]
        | [string, string, string, string, string, string, string]
        | [string, string, string, string, string, string, string, string]
        | [string, string, string, string, string, string, string, string, string]
        | [string, string, string, string, string, string, string, string, string, string]
        | [string, string, string, string, string, string, string, string, string, string, string]
        | [string, string, string, string, string, string, string, string, string, string, string, string]
        | [string, string, string, string, string, string, string, string, string, string, string, string, string]
        | [
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
          ]
        | [
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
          ]
        | [
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
          ]
        | [
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
          ]
        | [
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
          ]
        | [
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
          ]
        | [
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
          ];
      progress?: Progress;
    }
  | {
      type: 'verification.environment';
      mode: 'guest' | 'configured';
      summary: string;
      progress?: Progress;
    };

export interface Progress {
  /**
   * @maxItems 33
   */
  requirements?: {
    id: string;
    status: 'complete' | 'incomplete' | 'blocked';
    summary: string;
    /**
     * @maxItems 24
     */
    evidenceRefs: string[];
  }[];
  /**
   * @minItems 0
   */
  criteria?: {
    criterionId: string;
    verdict: 'PASSED' | 'FAILED' | 'INCONCLUSIVE' | 'SKIPPED';
    summary: string;
    evidenceRefs: string[];
  }[];
  /**
   * @maxItems 32
   */
  readings?: {
    itemId: string;
    quote: string;
  }[];
}
export interface FinishVerification {
  type: 'verification.finish';
  /**
   * 基于已取得证据解释本次验收结论。
   */
  summary: string;
  /**
   * 结构化步骤完成的执行证据，setup 无验收项时也必须提供。
   */
  evidenceRefs?: string[];
  progress?: Progress;
}
export interface BlockVerification {
  type: 'verification.block';
  /**
   * 具体缺失的前提或定义，交由上层修正；不改写标准。
   */
  summary: string;
  /**
   * 登录缺失或失效用 LOGIN_REQUIRED；账号角色、绑定或资格待确认用 IDENTITY_UNCONFIRMED；其余用 OTHER。平台在授权范围内先尝试一次人工交接，兼容旧回复省略此字段。
   */
  reasonCode?: 'LOGIN_REQUIRED' | 'IDENTITY_UNCONFIRMED' | 'OTHER';
  progress?: Progress;
}
export interface RequestHumanAssistance {
  type: 'verification.intervene';
  reason: string;
  /**
   * 本次人工需要处理的事项，不替代原验收标准。
   *
   * @minItems 1
   * @maxItems 10
   */
  items?:
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string];
  /**
   * 登录缺失单独交接，不占用其他未解决条件的交接机会。
   */
  reasonCode?: 'LOGIN_REQUIRED' | 'IDENTITY_UNCONFIRMED' | 'OTHER';
  progress?: Progress;
}
/**
 * 立即保存当前步骤已取得证据的部分验收结论，不结束步骤；已保存结论不会被后续故障覆盖。
 */
export interface RecordVerification {
  type: 'verification.record';
  /**
   * 基于已取得证据解释本次验收结论。
   */
  summary: string;
  progress: Progress;
}
/**
 * 封闭诊断字段，不包含原始正文、地址、认证头或任意供应商文本。
 */
export interface Diagnostics {
  /**
   * 失败发生阶段；REQUEST 不能进一步区分建连与等待响应头。
   */
  phase: 'REQUEST' | 'RESPONSE_BODY' | 'RESPONSE_PARSE' | 'HTTP_STATUS';
  /**
   * 已收到的 HTTP 状态；未收到响应头时为空。
   */
  httpStatus: number | null;
  /**
   * 归一化响应媒体类型；不保存原始头参数，缺失时为空。
   */
  contentType: 'application/json' | 'text/html' | 'text/plain' | 'other' | null;
  /**
   * 已读完整正文的结构类别，未读完时为 unknown。
   */
  responseFormat: 'json' | 'html' | 'text' | 'empty' | 'unknown';
  /**
   * 已完整读取的响应字节数；未读完或超限时为空。
   */
  responseBytes: number | null;
  /**
   * 按状态及有限特征生成的分类摘要，不复制供应商错误消息。
   */
  reason:
    | 'RATE_LIMITED'
    | 'GATEWAY_TIMEOUT'
    | 'UPSTREAM_UNAVAILABLE'
    | 'AUTH_REJECTED'
    | 'CONTEXT_LIMIT'
    | 'INVALID_RESPONSE'
    | 'REQUEST_TIMEOUT'
    | 'TRANSPORT_FAILURE'
    | 'RESPONSE_TOO_LARGE';
}
