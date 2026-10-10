/* 根据 contracts/schemas 自动生成，请勿手改；修改 Schema 后运行 pnpm contracts:generate。 */

export type HitlClient =
  | {
      type: 'authenticate';
      id: string;
      token: string;
    }
  | {
      type: 'command';
      commandId: string;
      command: BrowserCommand;
    }
  | {
      type: 'complete';
    };
/**
 * 节点可执行的封闭命令集合，不包含任意 shell 或 CLI 透传。
 */
export type BrowserCommand =
  | OpenSession
  | RenewSession
  | CloseSession
  | ObserveBrowser
  | ActBrowser
  | WaitBrowser
  | SaveAuthentication
  | BrowserInput
  | BrowserTrace
  | SetBrowserCookie;

/**
 * 预留本机容量并创建独立的受监管浏览器会话。
 */
export interface OpenSession {
  type: 'session.open';
  /**
   * 对应节点最近一次心跳中的 leaseRequestId，租约从该心跳发出时计时。
   */
  leaseRequestId: string;
  /**
   * 本次授权的有效时长，单位毫秒。
   */
  leaseTtlMs: number;
  /**
   * 会话从创建起允许存活的最长时间，续租不能超过此上限。
   */
  maxDurationMs: number;
  authState?: {
    /**
     * 节点私有登录状态名称，不是路径。
     */
    stateId: string;
    /**
     * 是否要求载入已有状态；首次人工登录时设为 false。
     */
    restore: boolean;
    /**
     * 自动复用允许首次无快照启动；损坏快照仍拒绝载入。
     */
    restoreIfPresent?: boolean;
    /**
     * 本轮不可变初始快照身份；并行两组必须相同。
     */
    snapshotId?: string;
  };
  /**
   * 在首次业务导航前启用网络元数据采集。
   */
  networkEvidence?: boolean;
  /**
   * 允许本会话在人工介入时提供实时浏览器画面。
   */
  liveView?: boolean;
  /**
   * 仅人工介入会话允许持续续期；不固定初始总时长，仍由独立短租约撤权。
   */
  renewable?: boolean;
}
/**
 * 延长仍然有效的会话租约，不排在浏览器操作队列后。
 */
export interface RenewSession {
  type: 'session.renew';
  /**
   * 对应节点最近一次心跳中的 leaseRequestId。
   */
  leaseRequestId: string;
  /**
   * 新租约的有效时长，单位毫秒；不能复活已经过期的会话。
   */
  leaseTtlMs: number;
}
/**
 * 撤销会话执行权限并关闭整组浏览器进程；过期租约可用于匹配原会话的清理。
 */
export interface CloseSession {
  type: 'session.close';
}
/**
 * 采集页面事实，返回新的 observationId 和该次观察范围内的元素目标。
 */
export interface ObserveBrowser {
  type: 'browser.observe';
  /**
   * 是否同时采集 PNG 截图；截图与 DOM 来自不同时间点。
   */
  screenshot?: boolean;
}
/**
 * 执行一次浏览器动作。生产环境默认关闭，直到引擎丢响应后的写入行为得到验证。
 */
export interface ActBrowser {
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
   * 目标所属的观察身份；使用过期元素目标会被拒绝。
   */
  observationId?: string;
  /**
   * visual.click 使用当前截图的视口 CSS 坐标。
   */
  x?: number;
  /**
   * visual.click 使用当前截图的视口 CSS 坐标。
   */
  y?: number;
}
/**
 * 等待一个明确的选择器及文本条件成立。
 */
export interface WaitBrowser {
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
/**
 * 仅人工控制时，将本次会话状态原子保存到任务绑定的节点私有登录槽。
 */
export interface SaveAuthentication {
  type: 'browser.auth.save';
}
/**
 * 仅人工处理页使用的受限视口输入；不计入 Agent 动作次数，仍受控制权与单条命令超时约束。
 */
export interface BrowserInput {
  type: 'browser.input';
  action: 'click' | 'text' | 'press' | 'scroll';
  x?: number;
  y?: number;
  value?: string;
  deltaX?: number;
  deltaY?: number;
}
/**
 * 开始或停止 Chromium trace，路径由节点生成，停止后按原证据链上传。
 */
export interface BrowserTrace {
  type: 'browser.trace';
  action: 'start' | 'stop';
}
/**
 * 仅人工接管时写入任务目标站点的 host-only、根路径、SameSite=Lax 会话 Cookie；不回传值，不自动刷新或保存共享登录槽。
 */
export interface SetBrowserCookie {
  type: 'browser.cookies.set';
  url: string;
  name: string;
  value: string;
  httpOnly: boolean;
}
