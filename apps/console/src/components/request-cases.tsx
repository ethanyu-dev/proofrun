import { useState } from 'react';
import type { RequestResultV2, VerificationReport } from '@proofrun/contracts';
import type { ApiClient } from '../api';
import { time } from './ui';
import { RequestStatus as Status } from './request-status';
import { ReportEvidenceDrawer } from './report-evidence';
import { OutcomeStatus } from './execution-outcome';

/** 逐项保留 case 与执行组上下文；同名标准不能跨 case 拼接证据。 */
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
      {value.cases.map((member, index) => (
        <details
          className="panel request-case"
          key={member.caseId}
          open={member.reportStatus !== 'PASSED'}
        >
          <summary className="request-case-heading">
            <span className="request-index">
              {String(index + 1).padStart(2, '0')}
            </span>
            <span className="request-case-title">
              <strong>{member.title}</strong>
              <span className="mono muted request-id">{member.caseId}</span>
            </span>
            <span className="request-case-verdict">
              {member.reportStatus ? (
                <Status value={member.reportStatus} />
              ) : (
                '等待完整结果'
              )}
            </span>
          </summary>
          <div className="request-case-body">
            <p className="request-origin">
              {member.executionOrigin === 'reused'
                ? '复用已有执行，本请求未重新执行此 case。'
                : '由本请求创建执行。'}
              {member.sourceCaseId && ` 重跑来源：${member.sourceCaseId}`}
            </p>
            <div className="request-arms">
              {(['llm', 'jev'] as const).map((mode) => {
                const arm = member.arms.find((a) => a.executionMode === mode);
                return (
                  <section className="request-arm" key={mode}>
                    <h3>{mode === 'llm' ? 'LLM' : 'JEV + LLM'}</h3>
                    {!arm ? (
                      <p>不适用</p>
                    ) : (
                      <>
                        <p>
                          <Status value={arm.result.status} /> ·{' '}
                          {arm.result.reportStatus ? (
                            <Status value={arm.result.reportStatus} />
                          ) : (
                            '尚无报告'
                          )}
                        </p>
                        <p className="muted">
                          执行创建于 {time(arm.createdAt)}
                        </p>
                        {arm.result.queueReason && (
                          <p className="request-arm-reason">
                            <span className="muted">排队原因</span>
                            {arm.result.queueReason.message}
                          </p>
                        )}
                        {arm.result.executionOutcome && (
                          <p>
                            执行原因：
                            <OutcomeStatus
                              outcome={arm.result.executionOutcome}
                            />
                          </p>
                        )}
                        {arm.result.result && (
                          <p>{arm.result.result.summary}</p>
                        )}
                        <p>
                          后续清理：
                          {arm.result.cleanup ? (
                            <Status value={arm.result.cleanup.status} />
                          ) : (
                            '未声明'
                          )}
                        </p>
                        {arm.archivedAt && <p>证据已清理，结论保留。</p>}
                        <p className="request-arm-links">
                          <a
                            href={`#/tasks/${encodeURIComponent(arm.taskId)}?request=${encodeURIComponent(value.requestId)}`}
                          >
                            执行详情与操作
                          </a>
                          <a
                            href={`#/reports/${encodeURIComponent(arm.taskId)}?request=${encodeURIComponent(value.requestId)}`}
                          >
                            原始报告与清理记录
                          </a>
                        </p>
                      </>
                    )}
                  </section>
                );
              })}
            </div>
            <h3 className="request-section-heading">
              逐项验收 <span>{member.criteria.length} 项</span>
            </h3>
            {member.criteria.map((criterion) => (
              <section
                className="request-criterion"
                key={criterion.criterionId}
              >
                <div className="request-criterion-heading">
                  <h4>{criterion.expectedResult}</h4>
                  <Status value={criterion.status} />
                </div>
                <p className="muted">
                  {criterion.stepId} · {criterion.description}
                </p>
                {criterion.disagreement && (
                  <p className="report-notice">
                    组间结论不同，请对照双方证据。
                  </p>
                )}
                {criterion.coverageDifference && (
                  <p>两组覆盖不同，尚不能当作明确判断冲突。</p>
                )}
                <div className="request-arms">
                  {criterion.arms.map((reading) => {
                    const arm = member.arms.find(
                      (a) => a.taskId === reading.taskId,
                    )!;
                    return (
                      <div className="request-arm" key={reading.taskId}>
                        <strong>
                          {reading.executionMode === 'llm'
                            ? 'LLM'
                            : 'JEV + LLM'}{' '}
                          ·{' '}
                          {reading.verdict ? (
                            <Status value={reading.verdict} />
                          ) : (
                            '缺少报告'
                          )}
                        </strong>
                        <p>{reading.summary || '该项尚无交付依据。'}</p>
                        {reading.evidenceRefs.map((id) => {
                          const evidence = arm.result.result?.evidence.find(
                            (a) => a.id === id,
                          );
                          return evidence ? (
                            <button
                              className="button button-secondary button-small"
                              key={id}
                              disabled={!!arm.archivedAt}
                              onClick={(event) => {
                                event.currentTarget.focus();
                                setSelected({
                                  artifact: { ...evidence, uri: evidence.url },
                                  context: `${member.caseId} · ${reading.executionMode} · ${criterion.expectedResult}`,
                                });
                              }}
                            >
                              {arm.archivedAt
                                ? '证据已清理'
                                : `查看 ${evidence.kind} 证据`}
                            </button>
                          ) : (
                            <span key={id}>证据引用不可用：{id}</span>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
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
                  {steps.map((step) => (
                    <section key={step.stepId}>
                      <h4>
                        {step.stepId} · {step.description}
                      </h4>
                      {step.expected.length > 0 && (
                        <ul>
                          {step.expected.map((expected, index) => (
                            <li key={index}>{expected}</li>
                          ))}
                        </ul>
                      )}
                      <div className="request-arms">
                        {member.arms.map((arm) => {
                          const result = arm.result.steps.find(
                            (s) => s.stepId === step.stepId,
                          );
                          return (
                            <p key={arm.taskId}>
                              {arm.executionMode === 'llm'
                                ? 'LLM'
                                : 'JEV + LLM'}{' '}
                              ·{' '}
                              {result ? (
                                <>
                                  <Status value={result.status} /> ·{' '}
                                  {result.summary}
                                </>
                              ) : (
                                '尚无记录'
                              )}
                            </p>
                          );
                        })}
                      </div>
                    </section>
                  ))}
                </details>
              ) : null;
            })}
          </div>
        </details>
      ))}
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
