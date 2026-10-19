import { useState } from 'react';
import type { RequestResultV2, VerificationReport } from '@proofrun/contracts';
import type { ApiClient } from '../api';
import { displayedCaseArm, displayedCriterion } from '../request-presentation';
import { Status, time } from './ui';
import { CaseVerificationProgress } from './case-verification-progress';
import { CriterionStatus } from './report-status';
import { ReportEvidenceDrawer } from './report-evidence';
import { OutcomeStatus } from './execution-outcome';

/** case 和逐项验收直接展开；历史双跑仅展示选定执行，证据保持相同归属。 */
export function RequestCases({
  api,
  value,
}: {
  api: ApiClient;
  value: RequestResultV2;
}) {
  const [selected, setSelected] = useState<{
    artifact: VerificationReport['artifacts'][number];
    context: string;
  }>();
  return (
    <div className="request-cases">
      {value.cases.map((member, index) => {
        const arm = displayedCaseArm(member);
        return (
          <section className="panel request-case" key={member.caseId}>
            <header className="request-case-heading">
              <span className="request-index">
                {String(index + 1).padStart(2, '0')}
              </span>
              <div className="request-case-title">
                <strong>{member.title}</strong>
                <span className="mono muted request-id">{member.caseId}</span>
              </div>
              <CaseVerificationProgress member={member} />
            </header>
            <div className="request-case-body">
              <p className="request-origin">
                {member.executionOrigin === 'reused'
                  ? '复用已有执行，本请求未重新执行此 case。'
                  : '由本请求创建执行。'}
                {member.sourceCaseId && ` 重跑来源：${member.sourceCaseId}`}
              </p>
              {arm && (
                <section className="request-record">
                  <p className="muted">执行创建于 {time(arm.createdAt)}</p>
                  {arm.result.queueReason && (
                    <p>排队原因：{arm.result.queueReason.message}</p>
                  )}
                  {arm.result.executionOutcome && (
                    <p>
                      执行情况：
                      <OutcomeStatus outcome={arm.result.executionOutcome} />
                    </p>
                  )}
                  {arm.result.result && <p>{arm.result.result.summary}</p>}
                  {!arm.result.result &&
                    !['QUEUED', 'RUNNING'].includes(arm.result.status) && (
                      <p>执行已结束，缺少报告。</p>
                    )}
                  {arm.archivedAt && <p>证据已清理，验证记录保留。</p>}
                  <p className="request-arm-links">
                    <a
                      href={`#/tasks/${encodeURIComponent(arm.taskId)}?request=${encodeURIComponent(value.requestId)}`}
                    >
                      执行详情与操作
                    </a>
                  </p>
                </section>
              )}
              <h3 className="request-section-heading">
                逐项验收 <span>{member.criteria.length} 项</span>
              </h3>
              {member.criteria.map((criterion) => {
                const reading = displayedCriterion(
                  member,
                  criterion.criterionId,
                );
                return (
                  <section
                    className="request-criterion"
                    key={criterion.criterionId}
                  >
                    <div className="request-criterion-heading">
                      <h4>{criterion.expectedResult}</h4>
                      <CriterionStatus value={reading?.verdict} />
                    </div>
                    <p className="muted">
                      {criterion.stepId} · {criterion.description}
                    </p>
                    <p>{reading?.summary || '该项尚无验收记录。'}</p>
                    {reading?.evidenceRefs.map((id) => {
                      const evidence = arm?.result.result?.evidence.find(
                        (item) => item.id === id,
                      );
                      return evidence ? (
                        <button
                          className="button button-secondary button-small"
                          key={id}
                          disabled={!!arm?.archivedAt}
                          onClick={(event) => {
                            event.currentTarget.focus();
                            setSelected({
                              artifact: { ...evidence, uri: evidence.url },
                              context: `${member.caseId} · ${criterion.expectedResult}`,
                            });
                          }}
                        >
                          {arm?.archivedAt
                            ? '证据已清理'
                            : `查看 ${evidence.kind} 证据`}
                        </button>
                      ) : (
                        <span key={id}>证据引用不可用：{id}</span>
                      );
                    })}
                  </section>
                );
              })}
              {(['准备步骤', '验证步骤', '后续清理'] as const).map((label) => {
                const steps = (member.steps ?? []).filter((step) =>
                  label === '后续清理'
                    ? step.cleanup
                    : !step.cleanup &&
                      step.type ===
                        (label === '准备步骤' ? 'setup' : 'verification'),
                );
                return steps.length ? (
                  <details className="request-step-group" key={label}>
                    <summary>
                      {label} · {steps.length} 步
                    </summary>
                    {steps.map((step) => {
                      const result = arm?.result.steps.find(
                        (item) => item.stepId === step.stepId,
                      );
                      return (
                        <section key={step.stepId}>
                          <h4>
                            {step.stepId} · {step.description}
                          </h4>
                          {step.expected.length > 0 && (
                            <ul>
                              {step.expected.map((expected, i) => (
                                <li key={i}>{expected}</li>
                              ))}
                            </ul>
                          )}
                          <p>
                            {result ? (
                              <>
                                <Status value={result.status} /> ·{' '}
                                {result.summary}
                              </>
                            ) : (
                              '尚无记录'
                            )}
                          </p>
                        </section>
                      );
                    })}
                  </details>
                ) : null;
              })}
            </div>
          </section>
        );
      })}
      {selected && (
        <ReportEvidenceDrawer
          api={api}
          artifact={selected.artifact}
          context={selected.context}
          close={() => setSelected(undefined)}
        />
      )}
    </div>
  );
}
