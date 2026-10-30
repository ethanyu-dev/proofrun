/* 根据 contracts/schemas 自动生成，请勿手改；修改 Schema 后运行 pnpm contracts:generate。 */

/**
 * 控制面 HTTP 写入请求；凭据通过 Authorization 传递，执行身份由服务端生成。
 */
export type ControlRequest =
  | EnrollNode
  | PairNode
  | ClaimExecution
  | SubmitBrowserCommand
  | CompleteExecution
  | {
      type: 'execution.intervene';
      reason: string;
      /**
       * 人工控制代次；旧页面和旧模型决定不能操作恢复后的会话。
       */
      controlRevision?: number;
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
       * 稳定的人工介入原因，不依赖自由文本聚合。
       */
      reasonCode?:
        | 'GENERAL'
        | 'LOGIN_REQUIRED'
        | 'IDENTITY_CHECK_UNMET'
        | 'ENVIRONMENT_NOT_READY'
        | 'LOGIN_RECIPE_MISSING'
        | 'LOGIN_RECIPE_UNAVAILABLE'
        | 'LOGIN_FORM_MISMATCH'
        | 'LOGIN_CHALLENGE_OR_REJECTED';
      /**
       * @maxItems 10
       */
      conditionKeys?:
        | []
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
  | {
      type: 'execution.control';
      action: 'acknowledge' | 'resume';
      /**
       * 人工控制代次；旧页面和旧模型决定不能操作恢复后的会话。
       */
      controlRevision: number;
    };
/**
 * 复用节点命令结构；领域层仅允许 worker 提交 browser.* 操作。
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
  | SetBrowserCookie
  | {
      type: 'browser.identity.prepare';
      url: string;
      profileRef?: string;
      /**
       * @maxItems 32
       */
      checks: {
        method: 'text' | 'absent';
        value: string;
      }[];
      /**
       * 仅全部身份条件可自动核验时保存快照；人工条件由 HITL 确认。
       */
      saveSnapshot: boolean;
      /**
       * 平台分配的标签页分组身份，不是模型指定的活动页；同一 profile 内独立保存观察引用。
       */
      tabScope?: string;
    }
  | {
      type: 'browser.cookies.clear';
      url: string;
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
      /**
       * 平台分配的标签页分组身份，不是模型指定的活动页；同一 profile 内独立保存观察引用。
       */
      tabScope?: string;
    }
  | {
      type: 'session.control';
      mode: 'AUTO' | 'HUMAN';
      revision: number;
      grant?: {
        id: string;
        tokenHash: string;
        connectExpiresAt: number;
        expiresAt: number;
        origin: string;
        authRevision: number;
        state: {
          [k: string]: unknown;
        };
      };
    }
  | {
      type: 'session.watch';
      revision: number;
      grant: {
        id: string;
        tokenHash: string;
        connectExpiresAt: number;
        expiresAt: number;
        origin: string;
        authRevision: number;
        state: {
          [k: string]: unknown;
        };
      };
    }
  | {
      type: 'session.profile.publish';
    };
/**
 * 执行者按原验收标准提交的结果；控制面验证覆盖、聚合与证据归属。
 */
export type VerificationReport = {
  protocolVersion: '0.1';
  taskId: string;
  lifecycle: 'COMPLETED' | 'CANCELLED' | 'TIMED_OUT';
  executionDisposition: 'EXECUTED' | 'BLOCKED' | 'ERROR';
  verdict: 'PASSED' | 'FAILED' | 'INCONCLUSIVE' | null;
  summary: string;
  criteria: {
    criterionId: string;
    verdict: 'PASSED' | 'FAILED' | 'INCONCLUSIVE' | 'SKIPPED';
    summary: string;
    evidenceRefs: string[];
  }[];
  artifacts: {
    id: string;
    kind: 'DOM' | 'SCREENSHOT' | 'NETWORK' | 'TRACE' | 'RUNTIME';
    uri: string;
    sha256: string;
  }[];
  executionDetails?: ExecutionDetails;
  /**
   * 结构化任务的逐步执行事实；异常终止仍保留已完成验收。
   *
   * @minItems 1
   * @maxItems 64
   */
  steps?: [StepResult, ...StepResult[]];
  /**
   * 仅由人工处理服务写入；执行器不能伪造人为无法执行的结论。
   */
  humanDecision?: {
    outcome: 'UNEXECUTABLE';
    reason: string;
    decidedAt: string;
  };
  /**
   * 浏览器任务的交付正文和证据，不作为验证通过结论。
   */
  browserResult?: {
    outcome: 'COMPLETED' | 'INCOMPLETE';
    output: string;
    evidenceRefs: string[];
  };
  executor?: {
    kind: 'external';
    judgmentSource: 'external_agent';
    usageSource: 'unavailable';
    decisionCalls: number;
    modelCalls: null;
    promptTokens: null;
    completionTokens: null;
  };
};

export interface EnrollNode {
  /**
   * 固定请求种类，不允许混用其他操作字段。
   */
  type: 'node.enroll';
  /**
   * 注册绑定的内网资源池；节点心跳必须与此一致。
   */
  pool: string;
  /**
   * 管理员识别节点的显示名称。
   */
  name: string;
}
export interface PairNode {
  /**
   * 固定请求种类，不允许混用其他操作字段。
   */
  type: 'node.pair';
  /**
   * 节点本机持久化的安装身份，不能覆盖已注册身份。
   */
  nodeId: string;
  /**
   * 注册绑定的内网资源池；节点心跳必须与此一致。
   */
  pool: string;
  /**
   * 管理员签发的一次性配对码，成功使用后失效。
   */
  pairingToken: string;
}
export interface ClaimExecution {
  /**
   * 固定请求种类，不允许混用其他操作字段。
   */
  type: 'worker.claim';
  /**
   * 领取任务的执行进程标识；不作为鉴权凭据。
   */
  workerId: string;
  /**
   * worker 支持结构化步骤、等待和逐步结果；旧 worker 不得领取新版任务。
   */
  structuredSteps?: boolean;
  /**
   * 只将逐步预算任务派给能隔离并继续后续步骤的 worker。
   */
  stepBudgetVersion?: 1;
  identityVersion?: 1 | 2;
  profileTabsVersion?: 1;
  executionPlanVersion?: 1;
  /**
   * 可只执行模型决定，由服务端 runtime 管理版本 1 运行。
   */
  runtimeVersion?: 1;
  /**
   * 版本 1 支持基础套件，版本 2 同时支持 V2 原步骤预算；旧 worker 不领取基准任务。
   */
  benchmarkVersion?: 1 | 2;
}
export interface SubmitBrowserCommand {
  /**
   * 固定请求种类，不允许混用其他操作字段。
   */
  type: 'execution.command';
  /**
   * 业务命令幂等键；重试必须沿用相同 ID 和完整内容。
   */
  commandId: string;
  /**
   * 包含控制面等待时间的最长命令预算，单位毫秒。
   */
  timeoutMs: number;
  command: BrowserCommand;
  /**
   * 人工控制代次；旧页面和旧模型决定不能操作恢复后的会话。
   */
  controlRevision?: number;
  stepId?: string;
}
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
    /**
     * 复制完整磁盘 profile，仅人工成功交还后允许发布新版本。
     */
    fullProfile?: boolean;
    /**
     * Console 节点默认模板维护会话；使用保留槽位，保存后不重启浏览器。
     */
    nodeTemplate?: boolean;
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
  /**
   * 外部账号期限锚定 leaseRequestId 的节点单调时钟，不受人工续期延长。
   */
  externalAccount?: {
    leaseId: string;
    materialVersion: string;
    origin: string;
    ttlMs: number;
  };
  /**
   * 只在私密节点投递中附加，不得写入命令账本。
   *
   * @minItems 1
   * @maxItems 64
   */
  externalCookies?: [
    {
      name: string;
      value: string;
      domain: string;
      host_only: true;
      path: string;
      secure: boolean;
      http_only: boolean;
      same_site: 'Strict' | 'Lax' | 'None';
      expires_at: string | null;
    },
    ...{
      name: string;
      value: string;
      domain: string;
      host_only: true;
      path: string;
      secure: boolean;
      http_only: boolean;
      same_site: 'Strict' | 'Lax' | 'None';
      expires_at: string | null;
    }[],
  ];
  /**
   * 浏览器启动前应用的减少动画偏好；省略时节点默认 true，false 明确使用正常动画偏好。
   */
  reducedMotion?: boolean;
  /**
   * 复制节点已发布模板；maintenance 仅用于管理员维护，缺省为空白会话。
   */
  profileMode?: 'node-default' | 'maintenance';
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
  /**
   * 平台分配的标签页分组身份，不是模型指定的活动页；同一 profile 内独立保存观察引用。
   */
  tabScope?: string;
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
    | 'visual.click'
    | 'online'
    | 'pwa.cleanup'
    | 'network.probe';
  /**
   * 导航为 HTTP(S) URL；元素动作为当前观察 target；frame 为 iframe target 或 main；tab.switch/close 为已观察 tabId。
   */
  target?: string;
  /**
   * 填写/输入/选择的值、按键、滚动方向或 resize 的 WIDTHxHEIGHT。观察 viewport.scrollDistance=true 时，scroll 还接受 direction:pixels（1..1200）；旧方向保持 400 像素。
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
  /**
   * 平台分配的标签页分组身份，不是模型指定的活动页；同一 profile 内独立保存观察引用。
   */
  tabScope?: string;
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
  /**
   * 平台分配的标签页分组身份，不是模型指定的活动页；同一 profile 内独立保存观察引用。
   */
  tabScope?: string;
}
/**
 * 仅人工控制时，将本次会话状态原子保存到任务绑定的节点私有登录槽。
 */
export interface SaveAuthentication {
  type: 'browser.auth.save';
  /**
   * 平台分配的标签页分组身份，不是模型指定的活动页；同一 profile 内独立保存观察引用。
   */
  tabScope?: string;
}
/**
 * 仅人工处理页使用的受限视口输入；不计入 Agent 动作次数，仍受控制权与单条命令超时约束。
 */
export interface BrowserInput {
  type: 'browser.input';
  action: 'click' | 'text' | 'press' | 'scroll' | 'drag';
  x?: number;
  y?: number;
  value?: string;
  deltaX?: number;
  deltaY?: number;
  /**
   * 平台分配的标签页分组身份，不是模型指定的活动页；同一 profile 内独立保存观察引用。
   */
  tabScope?: string;
  /**
   * 人工拖动的有界视口轨迹；松手后整段提交，首点 atMs 为 0，时间单调不减，执行中失败也尝试释放左键。
   *
   * @minItems 2
   * @maxItems 256
   */
  points?: [
    {
      x: number;
      y: number;
      atMs: number;
    },
    {
      x: number;
      y: number;
      atMs: number;
    },
    ...{
      x: number;
      y: number;
      atMs: number;
    }[],
  ];
}
/**
 * 开始或停止 Chromium trace，路径由节点生成，停止后按原证据链上传。
 */
export interface BrowserTrace {
  type: 'browser.trace';
  action: 'start' | 'stop';
  /**
   * 平台分配的标签页分组身份，不是模型指定的活动页；同一 profile 内独立保存观察引用。
   */
  tabScope?: string;
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
  /**
   * 平台分配的标签页分组身份，不是模型指定的活动页；同一 profile 内独立保存观察引用。
   */
  tabScope?: string;
}
export interface CompleteExecution {
  /**
   * 固定请求种类，不允许混用其他操作字段。
   */
  type: 'execution.complete';
  report: VerificationReport;
  /**
   * 人工控制代次；旧页面和旧模型决定不能操作恢复后的会话。
   */
  controlRevision?: number;
}
export interface ExecutionDetails {
  /**
   * 机器可读的执行结束原因；正常验收可为 null。
   */
  reasonCode: string | null;
  /**
   * 配置的模型名称，不包含 API 地址或凭据。
   */
  model: string;
  /**
   * 实际发起的模型请求次数。
   */
  modelCalls: number;
  /**
   * 提交的浏览器写动作数，包含初次导航。
   */
  actions: number;
  /**
   * 从领取到生成报告的耗时。
   */
  elapsedMs: number;
  /**
   * 按提交顺序记录命令，HTTP 重送不添加新身份。
   *
   * Items: 可追溯到控制面结果的命令身份。
   */
  commandIds: string[];
  /**
   * 已解析工具回复中的输入 token 计数；缺失 usage 的调用不计入。
   */
  promptTokens: number;
  /**
   * 已解析工具回复中的输出 token 计数；不能作为完整账单。
   */
  completionTokens: number;
  /**
   * 按实际提供者分别累计请求与已返回的用量；不是账单。
   */
  modelUsage?: {
    model: string;
    calls: number;
    promptTokens: number;
    completionTokens: number;
  }[];
}
export interface StepResult {
  /**
   * 对应规范化步骤的稳定身份。
   */
  stepId: string;
  /**
   * 执行生命周期，与 criteria 中的业务验收结论分开。
   */
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'BLOCKED' | 'ERROR' | 'SKIPPED';
  /**
   * 该步骤已观察事实或未完成原因。
   */
  summary: string;
  /**
   * 本步骤执行事实引用的控制面证据身份。
   */
  evidenceRefs: string[];
  /**
   * 仅包含本步骤已执行的验收项，未执行步骤为空。
   */
  criteria: {
    criterionId: string;
    verdict: 'PASSED' | 'FAILED' | 'INCONCLUSIVE' | 'SKIPPED';
    summary: string;
    evidenceRefs: string[];
  }[];
  /**
   * 步骤开始时间；未开始为 null。
   */
  startedAt: string | null;
  /**
   * 步骤结束时间；未结束或无法确认时为 null。
   */
  finishedAt: string | null;
  /**
   * 稳定的未完成原因码，预算耗尽按受阻记录。
   */
  reasonCode?: string | null;
  /**
   * 本步骤实际用量；清理多步各记录增量，额度由整段清理共享。业务耗时排除人工等待。
   */
  budgetUsage?: {
    elapsedMs: number;
    modelCalls: number;
    actions: number;
    limit: {
      timeoutMs: number;
      maxActions: number;
      maxModelCalls: number;
    };
    /**
     * 外部决定计数；不代表平台模型调用。
     */
    decisionCalls?: number;
  };
  /**
   * @maxItems 64
   */
  preconditions?: {
    id: string;
    description: string;
    status: 'SATISFIED' | 'UNSATISFIED' | 'UNCONFIRMED';
    source: 'observation' | 'human' | 'platform';
    /**
     * @maxItems 32
     */
    evidenceRefs: string[];
    controlRevision?: number;
    authRevision?: number;
  }[];
  /**
   * 阻塞时冻结的条件与页面证据；后续清理不能替换该快照。
   */
  blockage?: {
    /**
     * @maxItems 128
     */
    conditions: {
      id: string;
      description: string;
      summary: string;
      status: 'UNCONFIRMED' | 'UNSATISFIED';
    }[];
    evidenceRefs: string[];
    /**
     * 执行器冻结阻塞记录的时间，不冒充节点截图拍摄时间。
     */
    recordedAt: string;
    /**
     * 截图未取得时保留原因，不覆盖原始阻塞原因。
     */
    screenshotError?: string;
  };
  groupId?: string;
  /**
   * 环境准备先操作再检查 policy，READY 才允许本组验证。
   */
  phase?: 'PREPARING' | 'CHECKING' | 'READY' | 'VERIFYING' | 'CLEANUP';
  /**
   * 子项阅读进度与原文证据，不代表原验收标准已通过。
   *
   * @maxItems 32
   */
  readings?: {
    id: string;
    name: string;
    heading: string;
    status: 'pending' | 'observed' | 'recorded';
    quote?: string;
    /**
     * @maxItems 24
     */
    evidenceRefs: string[];
  }[];
  /**
   * @maxItems 32
   */
  environmentHistory?: {
    reason: string;
    /**
     * @maxItems 128
     */
    conditions: {
      id: string;
      description: string;
      summary: string;
      status: 'UNCONFIRMED' | 'UNSATISFIED';
    }[];
    controlRevision: number;
    authRevision: number;
    recordedAt: string;
  }[];
  /**
   * 原始要求完成声明，只是带来源的执行记录，不替代业务验收。
   *
   * @maxItems 33
   */
  requirements?: {
    id: string;
    status: 'pending' | 'recorded' | 'incomplete' | 'blocked';
    summary?: string;
    /**
     * @maxItems 24
     */
    evidenceRefs: string[];
  }[];
}
