/** 模型可见的附件来源；观察编号、命令编号和页面文本不能成为证据选项。 */
interface EvidenceContext {
  /** 当前轮提供的可用附件。 */
  evidence?: Array<{ id: string }>;
  /** 当前观察关联的附件，独立于观察本身的编号。 */
  observation?: { artifactRefs?: Array<{ artifactId: string }> };
  /** 历史正文保留的附件来源。 */
  previousObservations?: Array<{
    artifactRefs?: Array<{ artifactId: string }>;
  }>;
  /** 已持久化结论引用的来源。 */
  recordedCriteria?: Array<{ evidenceRefs: string[] }>;
  /** 已读面板的来源，可能早于近期附件窗口。 */
  interactionProgress?: { items: Array<{ evidenceRefs?: string[] }> };
  /** 阶段评估保留的来源，仍须通过执行器的步骤归属校验。 */
  workflow?: { steps: Array<{ evidenceRefs: string[] }> };
}

/** 保留上下文中仍可引用的历史附件；执行器继续独立校验归属、类型和当前步骤边界。 */
export function visibleEvidenceIds(context: EvidenceContext): string[] {
  return [
    ...new Set([
      ...(context.evidence?.map((item) => item.id) ?? []),
      ...(context.observation?.artifactRefs?.map((item) => item.artifactId) ??
        []),
      ...(context.previousObservations?.flatMap(
        (page) => page.artifactRefs?.map((item) => item.artifactId) ?? [],
      ) ?? []),
      ...(context.recordedCriteria?.flatMap((item) => item.evidenceRefs) ?? []),
      ...(context.interactionProgress?.items.flatMap(
        (item) => item.evidenceRefs ?? [],
      ) ?? []),
      ...(context.workflow?.steps.flatMap((item) => item.evidenceRefs) ?? []),
    ]),
  ];
}

/** 只递归收紧命名为 evidenceRefs 的数组，不改变引文、业务标准和其他字符串字段。 */
export function constrainEvidenceRefs(schema: object, ids: string[]): void {
  for (const [key, value] of Object.entries(schema)) {
    if (!value || typeof value !== 'object') continue;
    if (key === 'evidenceRefs' && value.type === 'array') {
      value.description =
        '只复制列出的附件 ID；observationId 不是证据，不得改写或猜测 UUID。';
      if (ids.length) value.items = { ...value.items, enum: ids };
      else value.maxItems = 0;
    } else constrainEvidenceRefs(value, ids);
  }
}
