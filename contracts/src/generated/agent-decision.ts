/* 根据 contracts/schemas 自动生成，请勿手改；修改 Schema 后运行 pnpm contracts:generate。 */

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
