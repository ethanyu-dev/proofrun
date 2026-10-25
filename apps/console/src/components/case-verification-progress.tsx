import { requestCaseVerification } from '@proofrun/contracts/request-verification';
import { VerificationStatusBadge } from './verification-status';
import {
  caseVerificationProgress,
  displayedCaseArm,
  type RequestCase,
} from '../request-presentation';
import { ReportProgress } from './report-status';
import { Status } from './ui';

/** 列表和报告共用通过数与生命周期，计数和状态始终属于同一次执行。 */
export function CaseVerificationProgress({ member }: { member: RequestCase }) {
  return (
    <div className="case-verification-progress">
      <span className="case-pass-count">
        <ReportProgress counts={caseVerificationProgress(member)} />
        <span className="muted">通过</span>
      </span>
      <VerificationStatusBadge
        status={requestCaseVerification(member).status}
      />
      <CaseExecutionStatus member={member} />
    </div>
  );
}

/** 只呈现当前展示组的执行事实；移动位置不改变状态口径。 */
export function CaseExecutionStatus({ member }: { member: RequestCase }) {
  const arm = displayedCaseArm(member);
  return arm ? (
    <Status value={arm.result.status} />
  ) : (
    <span className="muted">暂无执行记录</span>
  );
}
