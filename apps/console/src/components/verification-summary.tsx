import type { TaskDetail } from '@proofrun/contracts';
import {
  criterionResult,
  reportMode,
  verificationProgress,
} from '../report-presentation';
import { CriterionStatus, ReportProgress } from './report-status';

/** 固定模式顺序，进入任意一组报告都得到相同的对照列。 */
const MODES = ['llm', 'jev'] as const;

/** 汇总按验收项而非步骤计数；同一步有多个 expected 时逐项展开。 */
export function VerificationSummary({
  task,
  tasks,
}: {
  task: TaskDetail;
  tasks: TaskDetail[];
}) {
  const paired = !!task.definition.comparison;
  const modes = paired ? MODES : [reportMode(task)];
  const definitions = new Map(
    tasks.flatMap((item) =>
      item.definition.acceptanceCriteria
        .filter(
          (criterion) =>
            !item.definition.cleanupStepIds?.includes(criterion.stepId ?? ''),
        )
        .map((criterion) => [criterion.id, criterion] as const),
    ),
  );
  return (
    <section className="panel verification-summary-card" aria-label="验证汇总">
      <div className="section-heading verification-summary-heading">
        <h2>验证汇总</h2>
        <ReportProgress counts={verificationProgress(tasks)} />
      </div>
      <div className="table-scroll report-table-scroll">
        <table className="verification-matrix" aria-label="步骤与验收项汇总">
          <thead>
            <tr>
              <th>步骤</th>
              <th>验证项目</th>
              {modes.map((mode) => (
                <th key={mode}>
                  {mode === 'llm' ? 'LLM' : 'LLM + JEV（历史）'}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...definitions.values()].map((definition) => (
              <tr key={definition.id}>
                <td className="mono">{definition.stepId ?? '—'}</td>
                <td>
                  <strong>{definition.description}</strong>
                  <p className="muted wrap">{definition.expectedResult}</p>
                </td>
                {modes.map((mode) => {
                  const arm = tasks.find((item) => reportMode(item) === mode);
                  const result = arm
                    ? criterionResult(arm, definition.id)
                    : undefined;
                  return (
                    <td key={mode}>
                      <CriterionStatus value={result?.verdict} />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!definitions.size && (
        <p className="muted verification-summary-heading">
          本次没有业务验证项目。
        </p>
      )}
    </section>
  );
}
