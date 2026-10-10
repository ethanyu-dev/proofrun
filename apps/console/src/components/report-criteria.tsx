import { useState } from 'react';
import type { TaskDetail, VerificationReport } from '@proofrun/contracts';
import { ApiClient } from '../api';
import { ReportSummary } from './report-summary';
import { ReportStatus } from './report-status';
import { ReportEvidenceButton, ReportEvidenceDrawer } from './report-evidence';
import { stepStatus } from './step-completion';
import { Status } from './ui';

/** 未通过优先，其次是缺失或无法判定项，通过项默认折叠。 */
const PRIORITY = { FAILED: 0, INCONCLUSIVE: 1, SKIPPED: 1, PASSED: 2 };

/** 验收定义负责范围，存档负责事实；缺失记录只显示未验收，不能生成观察或理由。 */
export function ReportCriteria({
  api,
  task,
}: {
  api: ApiClient;
  task: TaskDetail;
}) {
  const [selection, setSelection] = useState<{
    artifact: VerificationReport['artifacts'][number];
    context: string;
  }>();
  const criteria = task.definition.acceptanceCriteria
    .filter(
      (item) => !task.definition.cleanupStepIds?.includes(item.stepId ?? ''),
    )
    .map((definition) => ({
      definition,
      result: (
        task.report?.criteria ??
        task.stepResults?.flatMap((step) => step.criteria)
      )?.find((item) => item.criterionId === definition.id),
    }))
    .sort(
      (a, b) =>
        PRIORITY[a.result?.verdict ?? 'SKIPPED'] -
        PRIORITY[b.result?.verdict ?? 'SKIPPED'],
    );
  return (
    <section aria-label="逐项验收" className="report-criteria">
      <div className="section-heading">
        <div>
          <h2>逐项验收</h2>
          <p className="muted">
            优先展示未通过和未得出结论的项，展开查看本次记录与证据。
          </p>
        </div>
      </div>
      {task.definition.steps
        ?.filter(
          (step) =>
            !task.definition.cleanupStepIds?.includes(step.stepId!) &&
            !criteria.some((item) => item.definition.stepId === step.stepId),
        )
        .map((step) => {
          const result = (task.report?.steps ?? task.stepResults)?.find(
            (item) => item.stepId === step.stepId,
          );
          const status = stepStatus(task, result);
          return (
            <details
              className="report-criterion"
              key={step.stepId}
              open={status !== 'COMPLETED'}
            >
              <summary>
                <span>
                  <small className="mono muted">{step.stepId} · 执行要求</small>
                  <strong>{step.description}</strong>
                </span>
                <Status value={status === 'SKIPPED' ? '未执行' : status} />
              </summary>
              <div className="report-criterion-body">
                <p className="muted">
                  本步骤未配置独立验收项，以下为执行要求与记录。
                </p>
                {step.policy.map((policy, index) => (
                  <p key={index}>{policy}</p>
                ))}
                {result ? (
                  <ReportSummary text={result.summary} />
                ) : (
                  <p>本步骤尚未执行。</p>
                )}
                <div className="report-evidence-grid">
                  {result?.evidenceRefs.map((ref) => {
                    const artifact = task.report?.artifacts.find(
                      (item) => item.id === ref,
                    );
                    return artifact ? (
                      <ReportEvidenceButton
                        key={ref}
                        api={api}
                        artifact={artifact}
                        archived={!!task.archived_at}
                        onSelect={() =>
                          setSelection({
                            artifact,
                            context: `${step.stepId} · ${step.description}`,
                          })
                        }
                      />
                    ) : (
                      <p key={ref} className="muted wrap">
                        证据 {ref} 暂不可预览。
                      </p>
                    );
                  })}
                </div>
              </div>
            </details>
          );
        })}
      {criteria.length === 0 && (
        <p className="muted">
          本次没有产品验收项，操作执行结果见执行要求与记录。
        </p>
      )}
      {criteria.map(({ definition, result }) => (
        <details
          className="report-criterion"
          key={definition.id}
          open={result?.verdict !== 'PASSED'}
        >
          <summary>
            <span>
              <small className="mono muted">
                {definition.id}
                {definition.stepId ? ` · ${definition.stepId}` : ''}
              </small>
              <strong>{definition.description}</strong>
            </span>
            {!result || result.verdict === 'SKIPPED' ? (
              <span className="status">未验收</span>
            ) : (
              <ReportStatus value={result.verdict} />
            )}
          </summary>
          <div className="report-criterion-body">
            <div className="report-expected">
              <h3>预期结果</h3>
              <p>{definition.expectedResult}</p>
            </div>
            <h3>本次观察与判定依据</h3>
            {result ? (
              <ReportSummary text={result.summary} />
            ) : (
              <p className="muted">
                本次报告未提供此项观察和判定，无法确认是否满足要求。
              </p>
            )}
            <h3>关联证据</h3>
            <p className="muted">
              要求的证据类型：{definition.evidenceKinds.join(' / ')}
            </p>
            <div className="report-evidence-grid">
              {result?.evidenceRefs.map((ref) => {
                const artifact = task.report?.artifacts.find(
                  (item) => item.id === ref,
                );
                return artifact ? (
                  <ReportEvidenceButton
                    key={ref}
                    api={api}
                    artifact={artifact}
                    archived={!!task.archived_at}
                    onSelect={() =>
                      setSelection({
                        artifact,
                        context: `${definition.id} · ${definition.description}`,
                      })
                    }
                  />
                ) : (
                  <p className="muted wrap" key={ref}>
                    证据 {ref} 未收录，无法预览。
                  </p>
                );
              })}
            </div>
            {!result?.evidenceRefs.length && (
              <p className="muted">未关联证据。</p>
            )}
          </div>
        </details>
      ))}
      {selection && (
        <ReportEvidenceDrawer
          key={selection.artifact.id}
          api={api}
          {...selection}
          close={() => setSelection(undefined)}
        />
      )}
    </section>
  );
}
