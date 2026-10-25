import type {
  ExecutionTimeline,
  StepResult,
  TaskDetail,
} from '@proofrun/contracts';

/** 操作只含控制面允许公开的摘要，截图必须从认证接口读取。 */
export type TimelineCommand = ExecutionTimeline['commands'][number];
/** 步骤回放保留定义、执行状态与已存档截图，不将执行完成解释为验收通过。 */
export interface PlaybackStep {
  /** 稳定步骤身份，用于切换和增量刷新。 */
  id: string;
  /** 用户定义的步骤说明。 */
  description: string;
  /** 原始步骤结果，尚未执行时不存在。 */
  result?: StepResult | undefined;
  /** 只归入时间范围唯一匹配的操作。 */
  commands: TimelineCommand[];
  /** 合并显式证据引用与本步操作生成的截图，按身份去重。 */
  screenshots: TimelineCommand['screenshots'];
}

/** 历史命令未持久化 stepId，仅在浏览器分组与时间区间唯一命中时归属；边界、缺失与重叠均不猜测。 */
export function playbackSteps(
  task: TaskDetail,
  commands: TimelineCommand[],
): PlaybackStep[] {
  const results = task.report?.steps ?? task.stepResults ?? [];
  const definitions = task.definition.steps ?? [];
  const ids = [
    ...new Set([
      ...definitions.map((s) => s.stepId).filter((id): id is string => !!id),
      ...results.map((s) => s.stepId),
    ]),
  ];
  const steps: PlaybackStep[] = ids.map((id) => ({
    id,
    description: definitions.find((s) => s.stepId === id)?.description ?? id,
    result: results.find((s) => s.stepId === id),
    commands: [],
    screenshots: [],
  }));
  const unassigned: TimelineCommand[] = [];
  for (const command of commands) {
    const timestamp = Date.parse(command.created_at);
    const matches = steps.filter(
      ({ result }) =>
        result?.startedAt &&
        (!command.tabScope ||
          !result.groupId ||
          command.tabScope === result.groupId) &&
        timestamp >= Date.parse(result.startedAt) &&
        (result.finishedAt
          ? timestamp < Date.parse(result.finishedAt)
          : result.status === 'RUNNING'),
    );
    if (matches.length === 1) matches[0]!.commands.push(command);
    else unassigned.push(command);
  }
  for (const step of steps) {
    const result = step.result;
    const refs = new Set([
      ...(result?.evidenceRefs ?? []),
      ...(result?.criteria.flatMap((c) => c.evidenceRefs) ?? []),
      ...(result?.blockage?.evidenceRefs ?? []),
    ]);
    const screenshots = new Map(
      step.commands.flatMap((c) => c.screenshots).map((s) => [s.id, s]),
    );
    for (const artifact of task.report?.artifacts ?? []) {
      if (
        artifact.kind === 'SCREENSHOT' &&
        refs.has(artifact.id) &&
        !screenshots.has(artifact.id)
      )
        screenshots.set(artifact.id, {
          id: artifact.id,
          sha256: artifact.sha256,
          state: task.archived_at ? 'ARCHIVED' : 'AVAILABLE',
        });
    }
    step.screenshots = [...screenshots.values()];
  }
  if (unassigned.length || !steps.length)
    steps.push({
      id: 'unassigned',
      description: steps.length
        ? '未能归属到具体步骤的操作'
        : '本次执行的操作记录',
      commands: unassigned,
      screenshots: [
        ...new Map(
          unassigned.flatMap((c) => c.screenshots).map((s) => [s.id, s]),
        ).values(),
      ],
    });
  return steps;
}

/** 用清晰动词呈现操作；未知类型保留原名称，避免误译历史动作。 */
export function actionLabel(command: TimelineCommand): string {
  const action = command.action ?? command.kind.replace(/^browser\./, '');
  const labels: Record<string, string> = {
    observe: '观察页面',
    screenshot: '截取页面',
    navigate: '打开页面',
    click: '点击',
    fill: '填写',
    type: '输入',
    press: '按键',
    scroll: '滚动',
    reload: '刷新页面',
    select: '选择',
    hover: '悬停',
    'cookies.clear': '清除 Cookie',
    input: '人工输入',
    wait: '等待',
  };
  return labels[action] ?? action;
}
