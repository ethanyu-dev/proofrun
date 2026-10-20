import { useState } from 'react';
import type { RequestResultV2, VerificationReport } from '@proofrun/contracts';
import { requestCaseVerification } from '@proofrun/contracts/request-verification';
import type { ApiClient } from '../api';
import { displayedCaseArm, displayedCriterion } from '../request-presentation';
import { time } from './ui';
import { CaseVerificationProgress } from './case-verification-progress';
import { CriterionStatus } from './report-status';
import { ReportEvidenceDrawer } from './report-evidence';
import { OutcomeStatus } from './execution-outcome';

/** 报告只展开验收结果与证据；执行步骤和操作通过任务详情追溯。 */
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
        const passed = requestCaseVerification(member).status === 'success';
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
              {!passed && (
                <p className="request-origin">
                  {member.executionOrigin === 'reused'
                    ? '复用已有执行，本请求未重新执行此 case。'
                    : '由本请求创建执行。'}
                  {member.sourceCaseId && ` 重跑来源：${member.sourceCaseId}`}
                </p>
              )}
              {arm && (
                <section className="request-record">
                  {!passed && (
                    <>
                      <p className="muted">执行创建于 {time(arm.createdAt)}</p>
                      {arm.result.executionOutcome && (
                        <p>
                          执行情况：
                          <OutcomeStatus
                            outcome={arm.result.executionOutcome}
                          />
                        </p>
                      )}
                      {arm.result.result && <p>{arm.result.result.summary}</p>}
                      {!arm.result.result &&
                        !['QUEUED', 'RUNNING'].includes(arm.result.status) && (
                          <p>执行已结束，缺少报告。</p>
                        )}
                    </>
                  )}
                  {arm.archivedAt && <p>证据已清理，验证记录保留。</p>}
                  <p className="request-arm-links">
                    <a
                      href={`#/tasks/${encodeURIComponent(arm.taskId)}?request=${encodeURIComponent(value.requestId)}`}
                    >
                      查看执行过程
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
                  <details
                    className="request-criterion"
                    key={criterion.criterionId}
                    // 成功 case 默认紧凑展示；异常记录仍展开，避免隐藏排查依据。
                    open={passed ? undefined : true}
                  >
                    <summary className="request-criterion-heading">
                      <h4>{criterion.expectedResult}</h4>
                      <CriterionStatus value={reading?.verdict} />
                    </summary>
                    <div className="request-criterion-detail">
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
                    </div>
                  </details>
                );
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
