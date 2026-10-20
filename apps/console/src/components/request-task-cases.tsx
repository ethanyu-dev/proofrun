import type { RequestResultV2 } from '@proofrun/contracts';
import { displayedCaseArm } from '../request-presentation';
import { OutcomeStatus } from './execution-outcome';
import { RequestExecutionEntry } from './request-execution-entry';
import { Status } from './ui';

/** 步骤类型只帮助理解执行顺序，不替代验收判定。 */
const STEP_LABELS = {
  setup: '准备',
  verification: '验证',
};

/** 任务页只展示定义、步骤进度和操作入口；验收结论与证据由报告页承载。 */
export function RequestTaskCases({ value }: { value: RequestResultV2 }) {
  return (
    <div className="request-cases">
      {value.cases.map((member, index) => {
        const arm = displayedCaseArm(member);
        const steps = member.steps ?? [];
        const completed = steps.filter((step) =>
          arm?.result.steps?.some(
            (result) =>
              result.stepId === step.stepId && result.status === 'COMPLETED',
          ),
        ).length;
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
              <div className="request-task-progress">
                {arm ? (
                  <Status value={arm.result.status} />
                ) : (
                  <span className="muted">暂无执行记录</span>
                )}
                {steps.length > 0 && (
                  <span className="muted">
                    步骤完成 {completed} / {steps.length}
                  </span>
                )}
              </div>
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
                  {arm.result.queueReason && (
                    <p>排队原因：{arm.result.queueReason.message}</p>
                  )}
                  {arm.result.executionOutcome && (
                    <p>
                      执行情况：
                      <OutcomeStatus outcome={arm.result.executionOutcome} />
                    </p>
                  )}
                  <RequestExecutionEntry
                    arm={arm}
                    requestId={value.requestId}
                  />
                </section>
              )}
              <h3 className="request-section-heading">
                验证目标 <span>{member.criteria.length} 项</span>
              </h3>
              <ul className="request-task-goals">
                {member.criteria.map((criterion) => (
                  <li key={criterion.criterionId}>
                    {criterion.expectedResult}
                  </li>
                ))}
              </ul>
              {steps.length > 0 && (
                <>
                  <h3 className="request-section-heading">执行步骤</h3>
                  {steps.map((step) => {
                    const result = arm?.result.steps?.find(
                      (item) => item.stepId === step.stepId,
                    );
                    return (
                      <section className="request-task-step" key={step.stepId}>
                        <div className="request-task-step-heading">
                          <h4>
                            {step.cleanup ? '清理' : STEP_LABELS[step.type]} ·{' '}
                            {step.stepId}
                          </h4>
                          <Status value={result?.status ?? 'PENDING'} />
                        </div>
                        <p>{step.description}</p>
                      </section>
                    );
                  })}
                </>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
