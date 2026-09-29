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
        | 'visual.click';
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
    }
  | FinishVerification
  | BlockVerification
  | RequestHumanAssistance;

export interface FinishVerification {
  type: 'verification.finish';
  /**
   * 基于已取得证据解释本次验收结论。
   */
  summary: string;
  criteria: {
    criterionId: string;
    verdict: 'PASSED' | 'FAILED' | 'INCONCLUSIVE' | 'SKIPPED';
    summary: string;
    evidenceRefs: string[];
  }[];
  /**
   * 结构化步骤完成的执行证据，setup 无验收项时也必须提供。
   */
  evidenceRefs?: string[];
}
export interface BlockVerification {
  type: 'verification.block';
  /**
   * 具体缺失的前提或定义，交由上层修正；不改写标准。
   */
  summary: string;
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
}
