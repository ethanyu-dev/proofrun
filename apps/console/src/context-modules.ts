/** 展示分组只作用于已保存正文，不补造模型未收到的字段。 */
export interface ContextModule {
  /** 人类可读的职责名称。 */
  title: string;
  /** 原始 JSON 内的字段路径。 */
  path: string;
  /** 当前模块的原始值，字符串正文不重复 JSON 转义。 */
  value: unknown;
}

/** 常用模块保持固定阅读顺序，LLM 和 JEV 的额外字段随后逐项展示。 */
const CONTEXT_LABELS: Record<string, string> = {
  task: '任务定义与验收标准',
  budgetRemaining: '剩余预算',
  previousObservations: '历史页面观察',
  recentOperations: '近期操作',
  evidence: '可引用证据',
  feedback: '错误与规划反馈',
  truncated: '上下文裁剪标记',
  jevProgress: 'JEV 进度',
  omittedTargets: 'JEV 省略目标数量',
  field: '待填写字段',
  page: '当前页面正文',
};

/** 从真实请求拆出模块；解析失败保留原文，不把空对象冒充已记录内容。 */
export function contextModules(
  request: Record<string, unknown>,
): ContextModule[] {
  const modules: ContextModule[] = [];
  const messages = Array.isArray(request.messages) ? request.messages : [];
  let context: Record<string, unknown> | undefined;
  let contextPath = 'state';
  if (
    request.state &&
    typeof request.state === 'object' &&
    !Array.isArray(request.state)
  )
    context = request.state as Record<string, unknown>;
  for (const [index, message] of messages.entries()) {
    if (!message || typeof message !== 'object') continue;
    const m = message as { role?: string; content?: unknown };
    const path = `messages[${index}].content`;
    if (m.role === 'system') {
      modules.push({ title: '系统指令', path, value: m.content });
      continue;
    }
    const content = Array.isArray(m.content)
      ? m.content.find((part: { type?: string }) => part?.type === 'text')?.text
      : m.content;
    if (m.role === 'user' && typeof content === 'string' && !context) {
      try {
        const parsed: unknown = JSON.parse(content);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          context = parsed as Record<string, unknown>;
          contextPath = `${path}（JSON）`;
        } else modules.push({ title: '用户消息', path, value: content });
      } catch {
        modules.push({ title: '用户消息', path, value: content });
      }
    } else modules.push({ title: '其他消息', path, value: m.content });
    if (Array.isArray(m.content)) {
      const images = m.content.filter(
        (part: { type?: string }) => part?.type === 'image_url',
      );
      if (images.length)
        modules.push({ title: '图片证据引用', path, value: images });
    }
  }
  if (context) {
    for (const [key, value] of Object.entries(context)) {
      if (
        key === 'observation' &&
        value &&
        typeof value === 'object' &&
        !Array.isArray(value)
      ) {
        const { text, targets, ...metadata } = value as Record<string, unknown>;
        if (text !== undefined)
          modules.push({
            title: '当前页面正文',
            path: `${contextPath}.observation.text`,
            value: text,
          });
        if (targets !== undefined)
          modules.push({
            title: '当前可操作目标',
            path: `${contextPath}.observation.targets`,
            value: targets,
          });
        modules.push({
          title: '当前页面身份与证据',
          path: `${contextPath}.observation`,
          value: metadata,
        });
      } else
        modules.push({
          title: CONTEXT_LABELS[key] ?? key,
          path: `${contextPath}.${key}`,
          value,
        });
    }
  }
  if (request.tools !== undefined)
    modules.push({ title: '工具定义', path: 'tools', value: request.tools });
  if (request.questions !== undefined)
    modules.push({
      title: 'JEV 问题与候选',
      path: 'questions',
      value: request.questions,
    });
  const {
    messages: _messages,
    state: _state,
    tools: _tools,
    questions: _questions,
    ...parameters
  } = request;
  modules.push({ title: '模型调用参数', path: 'request', value: parameters });
  return modules;
}

/** 字符数仅说明模块文本体积，不作为供应商 token 用量估算。 */
export function moduleText(value: unknown): string {
  return typeof value === 'string'
    ? value
    : (JSON.stringify(value, null, 2) ?? '未记录');
}
