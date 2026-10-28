import { Ajv } from 'ajv';
import formats from 'ajv-formats';
import { read, expand } from './mcp-schema.js';

/** 工具语义固定映射到底层操作；权限和类型限制同时驱动发现与调用。 */
export interface ExecutionTool {
  /** 公共工具身份和自包含调用说明。 */
  name: string;
  description: string;
  /** HTTP 对应的领域请求；view 不创建操作或续期。 */
  request: 'open' | 'bind' | 'view' | 'touch' | 'close' | 'decide';
  /** 唯一允许的决定类型，不能通过另一个工具提交其他意图。 */
  decisionType?: string;
  /** 最小入口权限；携带验证进度的浏览器动作仍由领域层要求双权限。 */
  scope: 'browser:control' | 'verification:control' | 'runs:read';
  /** 未指定时可访问同 principal 的通用浏览器或正式验证绑定。 */
  taskKind?: 'browser' | 'verification';
}
/** 只暴露已有执行能力；不提供原始命令、环境覆盖、最终报告或人工确认出口。 */
export const executionMcpCatalog: readonly ExecutionTool[] = [
  {
    name: 'browser_session_open',
    request: 'open',
    scope: 'browser:control',
    description:
      '创建通用 external 浏览器运行及控制绑定。只接受 taskKey、HTTP(S) url、objective 和稳定 operationId；不接受身份或预算覆盖。回执中的 controllerId 不是凭据；随后用 browser_session_get 等待 ACT。',
  },
  {
    name: 'browser_session_get',
    request: 'view',
    scope: 'runs:read',
    description:
      '读取本调用方控制上下文、当前观察/targets、预算、allowedActions、pendingOperation 和报告。可读取正式验证绑定；不刷新观察、不续期。只有 nextAction=ACT 时提交新决定。budget.timeMs/decisionTimeMs 持续递减；decisionDeadlineAt 是本轮提交期限，touch 不延长它。coverage 标明裁剪，按 artifactRefs 用 evidence_read 分页取回原始已采集内容。',
  },
  {
    name: 'browser_session_touch',
    request: 'touch',
    scope: 'browser:control',
    description:
      '显式续控制绑定的空闲期限，不重置步骤/任务预算。正式验证绑定还需要 verification:control，也可用 verification_touch_controller。重复 operationId 不重复续期。',
  },
  {
    name: 'browser_session_finish',
    request: 'decide',
    decisionType: 'verification.finish',
    scope: 'browser:control',
    taskKind: 'browser',
    description:
      '只完成通用浏览器目标。decision 中的 progress.requirements 必须登记原目标和实际证据，并用 summary 交付正文。登记成功不等于动作完成；查 operation_get、session_get 至报告及 closureVerified。不能用于正式 Case。',
  },
  {
    name: 'browser_session_close',
    request: 'close',
    scope: 'browser:control',
    taskKind: 'browser',
    description:
      '取消通用浏览器运行并请求回收会话。稳定 operationId；关闭请求不证明物理关闭，继续读取 closureVerified。正式 Case 使用 verification_cancel_run。',
  },
  {
    name: 'browser_observe',
    request: 'decide',
    decisionType: 'browser.observe',
    scope: 'browser:control',
    description:
      '基于最新 expectedRevision、observationId（正式验证还须 stepId）采集观察，可选择 screenshot。返回操作回执，完成后重读上下文并通过 evidence_read 读取图像/DOM。正式验证附带 progress 还需要 verification:control。',
  },
  {
    name: 'browser_act',
    request: 'decide',
    decisionType: 'browser.act',
    scope: 'browser:control',
    description:
      '在当前观察上执行一个封闭浏览器动作。target 从最新 targets 获取，禁止旧目标、任意 JS、shell、Cookie 或租约字段。正式验证附带 progress 需要双 control 权限。查原 operationId 确认效果；UNKNOWN 不能换键重放。',
  },
  {
    name: 'browser_wait',
    request: 'decide',
    decisionType: 'browser.wait',
    scope: 'browser:control',
    description:
      '等待明确 selector/text 条件；仍占一个在途决定并受原执行期限约束。先查原 operationId，再读最新上下文，不因客户端超时重复派发。',
  },
  {
    name: 'browser_network_list',
    request: 'decide',
    decisionType: 'network.requests',
    scope: 'browser:control',
    description:
      '读取当前观察已采集的脱敏网络摘要。外层 observationId 绑定 page；decision.observationId 取 page.network.observationId。支持有界分页；capture.coverage 仅说明显式范围内的完整性，全局 complete=false 或范围排除项不能证明无请求。不发送新 HTTP 请求；会消耗决定额度并推进上下文版本。',
  },
  {
    name: 'browser_network_detail',
    request: 'decide',
    decisionType: 'network.request_detail',
    scope: 'browser:control',
    description:
      '读取当前网络快照中已采集的 requestId 详情，不能补取未采集的正文或重放请求。外层 observationId 绑定 page，内层绑定 network；查询操作完成后从新 context.page.network 读取结果。',
  },
  {
    name: 'verification_bind_run',
    request: 'bind',
    scope: 'verification:control',
    taskKind: 'verification',
    description:
      '绑定本调用方通过 executor.kind=external 提交的精确 runId；不能接管 builtin 或将通用浏览器转为 Case。稳定 operationId，回执返回 controllerId，排队时用 get_context 等待 ACT。',
  },
  {
    name: 'verification_get_context',
    request: 'view',
    scope: 'runs:read',
    taskKind: 'verification',
    description:
      '读取正式验证的当前步骤、阶段、原始标准、观察、证据引用、预算及允许动作。不续期。PREPARING→CHECKING→VERIFYING→CLEANUP 由平台推进；最终读取报告、清理及 closureVerified。budget.decisionDeadlineAt 是本轮提交期限；SETTLEMENT_REQUIRED 时先 record 已有结论再 finish/block，不能继续浏览器操作。每个独立验收项确认后及时 record，避免超时丢失未提交结论。',
  },
  {
    name: 'verification_touch_controller',
    request: 'touch',
    scope: 'verification:control',
    taskKind: 'verification',
    description:
      '续本调用方正式验证控制绑定的空闲期限，不重置执行预算；GET 不续期，重复 operationId 不再次续期。',
  },
  {
    name: 'verification_record',
    request: 'decide',
    decisionType: 'verification.record',
    scope: 'verification:control',
    taskKind: 'verification',
    description:
      '保存当前 stepId 的部分验证进度。criterionId 来自原标准，证据来自当前运行。PREPARING/CHECKING 不接受独立 record，请用允许的动作或 finish_step。失败回执的 progressApplied=true 表示部分合法进度已保存。',
  },
  {
    name: 'verification_finish_step',
    request: 'decide',
    decisionType: 'verification.finish',
    scope: 'verification:control',
    taskKind: 'verification',
    description:
      '请求结束当前步骤或准备子阶段，不能指定下一阶段、最终 verdict 或 report。准备/清理须带本步骤新证据 evidenceRefs；CHECKING 必须核实原 policy。平台聚合报告，最后一步后继续读取 get_context 和 get_run。',
  },
  {
    name: 'verification_block_step',
    request: 'decide',
    decisionType: 'verification.block',
    scope: 'verification:control',
    taskKind: 'verification',
    description:
      '基于当前 stepId 和证据声明受阻，保留已保存进度；平台决定跳过范围及清理。受阻不等于产品 FAILED，不接受客户端伪造基础设施错误或最终报告。',
  },
  {
    name: 'verification_request_intervention',
    request: 'decide',
    decisionType: 'verification.intervene',
    scope: 'verification:control',
    taskKind: 'verification',
    description:
      '按当前步骤条件请求平台人工处理。不能自行确认身份或恢复控制。HUMAN_REQUIRED 期间等待人工流程，交还后必须读取新版本与新观察，不复用旧决定。',
  },
];
/** 所有引用在构造目录时展开，客户端无需访问外部 Schema 地址。 */
const schema = (name: string) => {
  const url = new URL(`../schemas/${name}.schema.json`, import.meta.url);
  return expand(read(url), url);
};
const requests = schema('external-execution-request');
const results = schema('external-execution-result');
const error = schema('public-error');
/** 原任务 operation_get 扩展为同时读取直接执行回执，旧结果形状保持有效。 */
export const executionMcpOperationSchema = results.oneOf.find(
  (branch: any) => branch.properties.kind.const === 'operation',
);
const controllerId = {
  type: 'string',
  format: 'uuid',
  description: '绑定或 session_open 返回的控制句柄；不是执行凭据。',
};
/** 每个工具仅包含对应决定分支，避免暴露不能执行的其他意图。 */
export const executionMcpTools = executionMcpCatalog.map((tool) => {
  const input: any =
    tool.request === 'view'
      ? {
          type: 'object',
          additionalProperties: false,
          properties: {},
          required: [],
        }
      : structuredClone(
          requests.oneOf.find(
            (branch: any) => branch.properties.type.const === tool.request,
          ),
        );
  delete input.properties.type;
  input.required = input.required.filter((key: string) => key !== 'type');
  if (tool.request === 'bind') {
    input.properties.runId = {
      type: 'string',
      pattern: '^[A-Za-z0-9_-]{1,160}$',
    };
    input.required.push('runId');
  } else if (tool.request !== 'open') {
    input.properties.controllerId = controllerId;
    input.required.push('controllerId');
  }
  if (tool.decisionType) {
    input.properties.decision = input.properties.decision.oneOf.find(
      (branch: any) => branch.properties.type.const === tool.decisionType,
    );
    if (!input.properties.decision)
      throw new Error(`工具没有对应决定分支：${tool.name}`);
    if (tool.taskKind === 'verification') input.required.push('stepId');
  }
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: input,
    outputSchema: {
      type: 'object',
      anyOf: [
        tool.request === 'view'
          ? results.oneOf.find(
              (branch: any) => branch.properties.kind.const === 'controller',
            )
          : executionMcpOperationSchema,
        error,
      ],
    },
  };
});
const ajv = new Ajv({ strict: true, allErrors: true });
formats.default(ajv);
/** 发现契约直接作为调用校验器，禁止仅按 TypeScript 类型转换后派发。 */
export const validateExecutionMcpArguments = new Map(
  executionMcpTools.map((tool) => [tool.name, ajv.compile(tool.inputSchema)]),
);
