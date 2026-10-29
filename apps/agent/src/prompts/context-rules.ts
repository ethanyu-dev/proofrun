import type { DecisionContextData } from '@proofrun/execution-core/execution/context';

/** 已发生的动作独立于当前工具权限；收尾期间也不能误读未知副作用。 */
const COMMAND_HISTORY_PROMPT = `history.commands 的 operationStatus/effect 表示命令结果；
成功写入不能重复，未知副作用不能猜测成未执行。`;
/** 键盘回执在动作权限消失后仍须解释，避免把派发前焦点当作业务结果。 */
const KEYBOARD_RECEIPT_PROMPT =
  '按键 scope 与 focusVerified 只证明派发前焦点，不证明业务校验成功。';

/** 运行时证据存在时说明其范围，不依赖本轮是否允许再次观察。 */
const RUNTIME_PROMPT = `page.runtime 提供同会话 Service Worker、Cache Storage 和 Console 的范围与完整性。
不要求人工打开 DevTools。
unavailable、truncated 或 complete=false 不能证明无异常；无注册与读取失败须区分。
不得以页面打开代替运行时验收。`;

/** 历史正文只证明当时事实，不能作为当前状态或操作目标。 */
const EXCERPT_PROMPT = `history.excerpts 保留对应观察的正文与 documents，不代表当前状态；
缺少历史 documents 不能断言当时的 lang，无有效 artifactRefs 时不能用于验收。
历史目标不能重放。`;

/** 出现文档声明后解释其证据含义，不从 URL 推导页面语言或额外验收项。 */
const DOCUMENT_PROMPT = `语言声明以 page.documents 中主文档（isMainFrame=true）的 lang 为准，
实际展示语言同时由正文证明；URL 的语言前缀不能推翻这两项事实。
task.url 是访问入口；除非原任务明确要求最终地址、重定向或语言持久性，
否则不能把地址必须等于入口、语言切换必须改变 URL 或刷新后保持语言新增为验收条件。`;

/** 已有身份及条件账本时保留其确认边界，不能把人工交还等同于业务通过。 */
const CONDITION_PROMPT = `state.conditions 中人工确认受作用域和代次约束；
候选身份描述不是登录证明。已有效确认的身份无需重复登录，有当前反证时请求人工核实。
人工处理必须遵守本轮工具权限；未提供人工工具时明确 block。
身份缺失用 LOGIN_REQUIRED，资格不明用 IDENTITY_UNCONFIRMED。
人工完成不能代替业务验收，前置条件满足不等于验收通过。`;

/** 进度只保存已有事实；具体字段按本轮存在的要求、验收项和阅读账本补充。 */
const PROGRESS_PROMPT = `用可选 progress 保存动作之前已取得的事实；
保存成功后程序才执行后续动作。`;
const REQUIREMENTS_PROMPT =
  'requirements 按 task.requirements 的原 id 逐项声明 complete/incomplete/blocked。';
const CRITERIA_PROMPT =
  'criteria 按原 criterionId 判定 PASSED/FAILED/INCONCLUSIVE。';
const READING_PROMPT = `readings 只登记已观察面板 itemId 和真实原文 quote。
state.readings 是阅读进度，不是验收结论。
已读面板不重复打开；原任务确需重访时提供 revisitReason。`;

/** 只依据模型本轮收到的结构化事实装配，不扫描任务或页面关键词猜测场景。 */
export function contextPrompts(context: DecisionContextData): string[] {
  const { task, state, page, history } = context;
  const hasReadings = (state.readings?.discovered ?? 0) > 0;
  return [
    history.commands.length ? COMMAND_HISTORY_PROMPT : '',
    history.commands.some((item) => item.keyboard)
      ? KEYBOARD_RECEIPT_PROMPT
      : '',
    history.excerpts.length ? EXCERPT_PROMPT : '',
    page.runtime ? RUNTIME_PROMPT : '',
    page.documents?.length ||
    history.excerpts.some((item) => item.documents?.length)
      ? DOCUMENT_PROMPT
      : '',
    state.conditions.length || state.phase === 'CHECKING'
      ? CONDITION_PROMPT
      : '',
    task.requirements.length || task.criteria.length || hasReadings
      ? PROGRESS_PROMPT
      : '',
    task.requirements.length ? REQUIREMENTS_PROMPT : '',
    task.kind !== 'browser' && task.criteria.length ? CRITERIA_PROMPT : '',
    hasReadings ? READING_PROMPT : '',
  ].filter(Boolean);
}
