import type { TaskDetail } from '@proofrun/contracts';
import { criterionResult, verificationProgress } from '../report-presentation';
import { CriterionStatus, ReportProgress } from './report-status';

/** 按当前任务的验收身份计数，清理项不参与业务汇总。 */
export function VerificationSummary({ task }: { task: TaskDetail }) {
  const definitions = task.definition.acceptanceCriteria.filter(
    (criterion) =>
      !task.definition.cleanupStepIds?.includes(criterion.stepId ?? ''),
  );
  return (
    <section className="panel verification-summary-card" aria-label="验证汇总">
      <div className="section-heading verification-summary-heading">
        <h2>验证汇总</h2>
        <ReportProgress counts={verificationProgress(task)} />
      </div>
      <div className="table-scroll report-table-scroll">
        <table className="verification-matrix" aria-label="步骤与验收项汇总">
          <thead>
            <tr>
              <th>步骤</th>
              <th>验证项目</th>
              <th>结果</th>
            </tr>
          </thead>
          <tbody>
            {definitions.map((definition) => (
              <tr key={definition.id}>
                <td className="mono">{definition.stepId ?? '—'}</td>
                <td>
                  <strong>{definition.description}</strong>
                  <p className="muted wrap">{definition.expectedResult}</p>
                </td>
                <td>
                  <CriterionStatus
                    value={criterionResult(task, definition.id)?.verdict}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!definitions.length && (
        <p className="muted verification-summary-heading">
          本次没有业务验证项目。
        </p>
      )}
    </section>
  );
}
