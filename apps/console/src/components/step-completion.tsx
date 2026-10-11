import { BudgetUsage, BudgetTotal } from './budget-usage';
import type { StepResult, TaskDetail } from '@proofrun/contracts';
import { Status } from './ui';
import { ReportStatus } from './report-status';

/** 汇总只摘取短原因，完整模型说明和证据放在逐项验收中。 */
const REASON_LIMIT = 72;

/** 终态不能继续显示等待或运行；原始步骤记录不被此展示转换修改。 */
export function stepStatus(
  task: TaskDetail,
  result: StepResult | undefined,
): StepResult['status'] {
  const raw = result?.status ?? 'PENDING';
  if (['QUEUED', 'RUNNING'].includes(task.state)) return raw;
  return raw === 'PENDING' ? 'SKIPPED' : raw === 'RUNNING' ? 'ERROR' : raw;
}

/** 截短原记录而不生成新原因；详细原文仍可在逐项验收中核对。 */
function shortReason(summary: string) {
  const text = summary.replace(/\s+/g, ' ').trim();
  return text.length > REASON_LIMIT ? `${text.slice(0, REASON_LIMIT)}…` : text;
}

/** 验证汇总按业务步骤列出每个验收项；前置要求和清理不伪装成业务验收项。 */
export function StepCompletion({
  task,
  card = false,
}: {
  task: TaskDetail;
  card?: boolean;
}) {
  if (!task.definition.steps) return null;
  const results = task.report?.steps ?? task.stepResults ?? [];
  const steps = task.definition.steps.filter(
    (step) => !task.definition.cleanupStepIds?.includes(step.stepId!),
  );
  return (
    <div className="criteria-list" aria-label="验证汇总">
      <div className="section-heading">
        <h2>验证汇总</h2>
      </div>
      <BudgetTotal task={task.definition} results={results} />
      <div className={card ? 'panel verification-summary-card' : undefined}>
        <div className="table-scroll report-table-scroll">
          <table aria-label="步骤与验收项汇总">
            <colgroup>
              <col style={{ width: '23%' }} />
              <col style={{ width: '12%' }} />
              <col style={{ width: '32%' }} />
              <col style={{ width: '10%' }} />
              <col style={{ width: '23%' }} />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">步骤</th>
                <th scope="col">执行状态</th>
                <th scope="col">验收项 / 前置要求</th>
                <th scope="col">验收结果</th>
                <th scope="col">简短原因</th>
              </tr>
            </thead>
            <tbody>
              {steps.flatMap((step) => {
                const result = results.find(
                  (item) => item.stepId === step.stepId,
                );
                const status = stepStatus(task, result);
                const definitions = task.definition.acceptanceCriteria.filter(
                  (item) => item.stepId === step.stepId,
                );
                // 同一步骤的多个验收项各占一行，共享执行状态；无验收项仍保留前置要求行。
                const rows = definitions.length ? definitions : [null];
                return rows.map((definition, index) => {
                  const criterion = definition
                    ? (result?.criteria.find(
                        (item) => item.criterionId === definition.id,
                      ) ??
                      task.report?.criteria.find(
                        (item) => item.criterionId === definition.id,
                      ))
                    : undefined;
                  const reason = result?.reasonCode?.endsWith(
                    '_BUDGET_EXCEEDED',
                  )
                    ? result.summary
                    : criterion &&
                        ['FAILED', 'INCONCLUSIVE', 'SKIPPED'].includes(
                          criterion.verdict,
                        )
                      ? criterion.summary
                      : ['BLOCKED', 'ERROR', 'SKIPPED'].includes(status)
                        ? (result?.summary ?? '本步骤未执行')
                        : null;
                  return (
                    <tr key={definition?.id ?? step.stepId}>
                      {index === 0 && (
                        <>
                          <td rowSpan={rows.length}>
                            <strong>
                              {step.stepId} ·{' '}
                              {step.type === 'setup' ? '前置操作' : '业务验收'}
                            </strong>
                            <p className="wrap">{step.description}</p>
                          </td>
                          <td rowSpan={rows.length}>
                            <Status
                              value={status === 'SKIPPED' ? '未执行' : status}
                            />
                            <BudgetUsage usage={result?.budgetUsage} />
                          </td>
                        </>
                      )}
                      <td>
                        {definition ? (
                          <>
                            <span className="mono muted wrap">
                              {definition.id}
                            </span>
                            <p className="wrap">{definition.expectedResult}</p>
                          </>
                        ) : (
                          <>
                            <p className="muted">
                              未配置独立验收项；执行状态表示本步骤的执行情况。
                            </p>
                            {step.policy.length > 0 && (
                              <p className="wrap">
                                前置要求：{step.policy.join('；')}
                              </p>
                            )}
                          </>
                        )}
                      </td>
                      <td>
                        {!definition ? (
                          '—'
                        ) : !criterion || criterion.verdict === 'SKIPPED' ? (
                          <span className="status">未验收</span>
                        ) : (
                          <ReportStatus value={criterion.verdict} />
                        )}
                      </td>
                      <td className="wrap">
                        {reason ? shortReason(reason) : '—'}
                        {result?.reasonCode && (
                          <p className="muted mono wrap">{result.reasonCode}</p>
                        )}
                      </td>
                    </tr>
                  );
                });
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
