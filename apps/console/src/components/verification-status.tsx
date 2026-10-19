import type { VerificationStatus } from '@proofrun/contracts';

/** 颜色只辅助识别，状态文字始终可读；执行完成不能代替验证成功。 */
export const VERIFICATION_LABELS: Record<VerificationStatus, string> = {
  success: '成功',
  failure: '失败',
  partial: '部分失败',
  pending: '验证中',
  unknown: '未能判定',
};

/** 统一请求总览与单 case 的业务结论。 */
export function VerificationStatusBadge({
  status,
}: {
  status: VerificationStatus;
}) {
  return (
    <span className={`verification-status verification-status-${status}`}>
      {VERIFICATION_LABELS[status]}
    </span>
  );
}
