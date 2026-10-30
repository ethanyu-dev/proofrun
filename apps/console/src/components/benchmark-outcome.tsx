import {
  benchmarkPassed,
  type BenchmarkCase,
} from '@proofrun/contracts/benchmark';

/** 列表直接区分能力阻塞、执行未完成与真实检查失败，不把零调用伪装成站点错误。 */
export function benchmarkOutcome(item: BenchmarkCase) {
  if (
    item.preflight?.status === 'BLOCKED' &&
    item.preflight.executionPolicy !== 'skip-steps'
  ) {
    const capabilities = [
      ...new Set(item.preflight.gaps.map((gap) => gap.capabilityName)),
    ];
    const steps = [...new Set(item.preflight.gaps.map((gap) => gap.stepId))];
    return {
      label: '能力不足 · 未启动',
      summary: `${steps.join('、')}：缺少${capabilities.join('、')}`,
    };
  }
  if (item.verdict === '仅完成能力预检')
    return { label: '未执行', summary: '仅评估任务定义，尚未执行真实验证' };
  if (benchmarkPassed(item))
    return { label: '通过', summary: '全部场景检查通过' };
  const steps = item.verification?.steps ?? [];
  const incomplete = steps.filter((step) => step.status !== 'COMPLETED');
  if (incomplete.length)
    return {
      label: incomplete.every(
        (step) => step.reasonCode === 'VERIFICATION_CAPABILITY_MISSING',
      )
        ? '部分步骤已跳过'
        : '执行未完成',
      summary: `${steps.filter((step) => step.status === 'COMPLETED').length}/${steps.length} 步完成；${incomplete.map((step) => step.stepId).join('、')} 未完成`,
    };
  return {
    label: '未通过',
    summary:
      item.checks
        .filter((check) => !check.passed)
        .map((check) => check.name)
        .join('；') || '缺少完整运行证据',
  };
}

/** 原始结果的诊断投影；不重算验收、不修改归档，只把未完成项和调用错误直接展示。 */
export function BenchmarkOutcome({ item }: { item: BenchmarkCase }) {
  const verification = item.verification;
  if (
    !verification ||
    (item.preflight?.status === 'BLOCKED' &&
      item.preflight.executionPolicy !== 'skip-steps') ||
    benchmarkPassed(item)
  )
    return null;
  const report = verification.report;
  if (!report) return null;
  const unfinished = verification.steps.filter(
    (step) => step.status !== 'COMPLETED',
  );
  const criteria = report.criteria.filter(
    (criterion) => criterion.verdict !== 'PASSED',
  );
  const errors = item.calls.filter((call) => call.status === 'ERROR');
  return (
    <section
      className="bench-notice bench-diagnosis"
      aria-label="本次未通过原因"
    >
      <strong>本次未通过原因 · {benchmarkOutcome(item).summary}</strong>
      <p>
        验收项{' '}
        {
          report.criteria.filter((criterion) => criterion.verdict === 'PASSED')
            .length
        }
        /{report.criteria.length} 通过；下面列出未完成项，已完成项保留原结论。
      </p>
      {criteria.map((criterion) => {
        const definition = verification.task.acceptanceCriteria.find(
          (entry) => entry.id === criterion.criterionId,
        );
        return (
          <div className="bench-diagnosis-row" key={criterion.criterionId}>
            <strong>
              {definition?.stepId ?? criterion.criterionId} ·{' '}
              {criterion.verdict === 'INCONCLUSIVE'
                ? '证据不足，无法判定'
                : criterion.verdict === 'SKIPPED'
                  ? '未验证'
                  : '验收失败'}
            </strong>
            <p>
              验收要求：{definition?.expectedResult ?? criterion.criterionId}
            </p>
            <p>{criterion.summary}</p>
          </div>
        );
      })}
      {unfinished.map((step) => (
        <div className="bench-diagnosis-row" key={step.stepId}>
          <strong>
            {step.stepId} · {step.reasonCode ?? step.status}
          </strong>
          {step.budgetUsage && (
            <p>
              动作 {step.budgetUsage.actions}/
              {step.budgetUsage.limit.maxActions} · 模型调用{' '}
              {step.budgetUsage.modelCalls}/
              {step.budgetUsage.limit.maxModelCalls}
            </p>
          )}
          {!criteria.length && <p>{step.summary}</p>}
        </div>
      ))}
      {errors.map((call) => (
        <p key={call.id}>
          模型调用异常：#{call.callIndex} · {call.stepId ?? '当前任务'} ·{' '}
          {call.error ?? '请求失败'} · {call.elapsedMs ?? '—'}{' '}
          ms（原始请求见下方轮次）
        </p>
      ))}
    </section>
  );
}
