import type {
  CaseStep,
  StepResult,
  VerificationTask,
} from '@proofrun/contracts';

/** 当前步骤提示隔离后续指令；收尾只能恢复上游明确指定的数据。 */
export function stepObjective(
  task: VerificationTask,
  step: CaseStep,
  previous: StepResult[] = [],
): string {
  return [
    `任务背景：${task.objective}`,
    `当前步骤：${step.description}`,
    `操作约束：${JSON.stringify(step.policy)}`,
    ...previous
      .filter(
        (item) =>
          item.status !== 'COMPLETED' ||
          item.criteria.some((c) => c.verdict !== 'PASSED'),
      )
      .map(
        (item) =>
          `前序异常：${item.stepId}（${item.status}）${item.summary.slice(0, 200)}`,
      ),
    '平台仅在 setup 准备通过后执行后续业务；前序业务验收异常不代表当前步骤失败。仍须核实本步必要条件，缺失则 verification.block，不虚构执行或验收通过。',
    ...(task.cleanupStepIds?.includes(step.stepId!)
      ? [
          '当前为业务清理阶段。只清理指定对象，不推测未提供的原值；前置操作可能未执行或部分完成，先确认对象现状。',
        ]
      : []),
    '账号显示为“个人”不能证明团队成员、非所有者或第三方未绑定，也不能单凭该显示否定 preconditions 中人工已确认的资格；未确认条件仍须核实。只执行当前步骤；verification.finish 只提交本步验收和执行证据。',
  ].join('\n');
}
