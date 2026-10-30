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
不得以页面打开代替运行时验收。
runtimeLists 区分原采集完整性 capture 与当前投影 omitted；用 context_read(section=runtime,path,offset) 分页补读，runtimeDetail 是同快照原始条目。
优先核对 runtimeDetail；继续翻页使用 runtimeDetail.nextOffset，而不是摘要目录的 nextOffset。
state.contextReads 自动保留已读页与实际缓存状态计数，不重复读第一页。
分页尚未读完时，用 progress.requirements 的 incomplete 和 summary 保存部分发现，省略尚未完成验收项的 progress.criteria。
INCONCLUSIVE 是证据不足的验收结论，不是“还没读完”的进度占位；同一快照的后续分页仍引用相同附件，不构成升级暂存结论所需的新增证据。
读完所需全部分页后再登记该项结论；若原采集缺失、截断或无法核实，仍如实登记 INCONCLUSIVE 或 block，不能因此猜测通过。`;

/** 历史正文只证明当时事实，不能作为当前状态或操作目标。 */
const EXCERPT_PROMPT = `history.excerpts 保留对应观察的正文与 documents，不代表当前状态；
缺少历史 documents 不能断言当时的 lang，无有效 artifactRefs 时不能用于验收。
历史目标不能重放。`;
/** 正文完全相同时仍保留历史证据身份；引用只复用文字，不把历史状态改成当前状态。 */
const EXCERPT_REF_PROMPT =
  '历史摘录的 textRef 指向本轮 page.text，表示文字完全相同；证据来源仍使用该历史摘录自身的 artifactRefs。';

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
/** 原文引用只在确实去重时解释；引用目标是本轮 task 内已有字段。 */
const REQUIREMENT_REF_PROMPT =
  'requirementRef 指向本轮 task 中的原始要求文本，按该字段完整内容执行，不把引用路径当作要求。';
const CRITERIA_PROMPT =
  'criteria 按原 criterionId 判定 PASSED/FAILED/INCONCLUSIVE。';
const READING_PROMPT = `阅读记录只放在工具参数 progress.readings 内，不能放到工具参数顶层。
itemId 使用 state.readings.items 的对应 id；quote 从该项 text 逐字复制一段连续原文，最多 600 字符。
不要把 name、heading、摘要或其他面板正文拼进 quote；只允许空白排版差异。
引文被拒绝时，修正 progress.readings 中的 quote，仍保持相同字段层级；登记失败会阻止同次动作，不能假定动作已经执行。
state.readings 是阅读进度，不是验收结论。
已读面板不重复打开；原任务确需重访时提供 revisitReason。`;
/** 未发现面板时没有合法 itemId，不能把验收项或任务要求身份误用作阅读项。 */
const NO_READINGS_PROMPT = `本轮没有子项阅读账本，省略 progress.readings，不能用验收项或要求的 ID 构造 itemId。
普通页面核验依据通过 summary 和 evidenceRefs 保存。`;

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
    history.excerpts.some((item) => item.textRef) ? EXCERPT_REF_PROMPT : '',
    page.runtime ? RUNTIME_PROMPT : '',
    page.view && page.view !== 'page'
      ? '本轮主动使用精简证据视图，正文、控件、截图省略不表示采集失败，不要求补齐所有页面内容。网络或运行时核验直接使用 page.network / page.runtimeDetail，无需恢复页面。只有任务还需要 DOM 事实或浏览器操作时才用 context_read(section=page) 恢复同一观察；不要仅因 text 为空切回页面。'
      : '',
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
    task.requirements.some((item) => item.requirementRef)
      ? REQUIREMENT_REF_PROMPT
      : '',
    task.kind !== 'browser' && task.criteria.length ? CRITERIA_PROMPT : '',
    hasReadings ? READING_PROMPT : NO_READINGS_PROMPT,
  ].filter(Boolean);
}
