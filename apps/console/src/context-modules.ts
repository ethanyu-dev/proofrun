/** 展示分组只作用于已保存正文，不补造模型未收到的字段。 */
export interface ContextModule {
  /** 人类可读的职责名称。 */
  title: string;
  /** 原始 JSON 内的字段路径。 */
  path: string;
  /** 当前模块的原始值，字符串正文不重复 JSON 转义。 */
  value: unknown;
}

/** 只为已存档字段提供标签；不参与新请求构造。 */
const CONTEXT_LABELS: Record<string, string> = {
  task: '任务定义与验收标准',
  state: '执行阶段与已保存进度',
  history: '历史命令与页面片段',
  budget: '剩余硬预算',
  workflow: '当前子目标与工作流',
  executionGuidance: '执行计划、进度与预算诊断',
  budgetRemaining: '剩余预算',
  previousObservations: '历史页面观察',
  recentOperations: '近期操作',
  evidence: '可引用证据',
  feedback: '错误与规划反馈',
  truncated: '上下文裁剪标记',
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
        ['page', 'observation'].includes(key) &&
        value &&
        typeof value === 'object' &&
        !Array.isArray(value)
      ) {
        const { text, targets, ...metadata } = value as Record<string, unknown>;
        if (text !== undefined)
          modules.push({
            title: '当前页面正文',
            path: `${contextPath}.${key}.text`,
            value: text,
          });
        if (targets !== undefined)
          modules.push({
            title: '当前可操作目标',
            path: `${contextPath}.${key}.targets`,
            value: targets,
          });
        modules.push({
          title: '当前页面身份与证据',
          path: `${contextPath}.${key}`,
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
  const {
    messages: _messages,
    state: _state,
    tools: _tools,
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
