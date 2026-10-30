import {
  benchmarkPassed,
  isV2BenchmarkSuite,
  benchmarkReleaseIssues,
  type BenchmarkRun,
} from '@proofrun/contracts/benchmark';

/** 场景完成情况与归档发布资格分开说明；离线看板不声称已经核实当前源码或报告时效。 */
export function benchmarkReleaseStatus(run: BenchmarkRun) {
  const complete =
    !!run.completedAt &&
    run.cases.length > 0 &&
    run.cases.every(benchmarkPassed);
  // V2 的失败仍是诊断失败，但没有发布阻断项，也不能充当基础套件的发布证明。
  if (isV2BenchmarkSuite(run.suite))
    return {
      label: !run.completedAt
        ? '诊断进行中'
        : complete
          ? '诊断通过'
          : '诊断未通过',
      passed: complete,
      issues: [] as string[],
      requiredForRelease: false,
    };
  const issues = benchmarkReleaseIssues(run);
  const development = run.release?.kind === 'development';
  return {
    requiredForRelease: true,
    label:
      run.mode === 'scripted'
        ? '需真实运行'
        : development
          ? complete
            ? '开发回归通过'
            : run.completedAt
              ? '开发回归未通过'
              : '等待完成'
          : issues.length
            ? '未满足发布条件'
            : '发布候选通过',
    passed:
      run.mode !== 'scripted' && (development ? complete : issues.length === 0),
    issues,
  };
}

/** 所有未满足条件直接展示，避免所有场景通过却只显示模糊的红色阻断。 */
export function BenchmarkReleaseConditions({ run }: { run: BenchmarkRun }) {
  const { issues, requiredForRelease } = benchmarkReleaseStatus(run);
  if (!requiredForRelease)
    return (
      <div className="bench-notice">
        V2 真实任务仅用于诊断，不参与发布门禁；失败或未运行不阻塞发布。
      </div>
    );
  return (
    <div className="bench-notice" aria-label="发布条件说明">
      <strong>
        {issues.length ? '尚未满足发布条件' : '归档发布条件已满足'}
      </strong>
      {issues.length > 0 && (
        <ul>
          {issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
      <span>
        实际发布时还需核实：源码指纹与待发布代码一致，报告在 24
        小时内且时间有效。此处读取归档，不代表最终发布检查已通过。
      </span>
    </div>
  );
}
