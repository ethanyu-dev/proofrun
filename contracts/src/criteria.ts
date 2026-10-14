import type { VerificationReport } from './generated/verification-report.js';

/** 非确定判定只能向明确业务结论推进，不能反向降级或改写已确认结果。 */
const PROVISIONAL_VERDICTS = new Set(['INCONCLUSIVE', 'SKIPPED']);
const FINAL_VERDICTS = new Set(['PASSED', 'FAILED']);
type Criterion = VerificationReport['criteria'][number];

/** Agent 与 API 共用补证规则；证据归属、类型与步骤生命周期仍由各自调用方校验。 */
export function isCriterionUpgrade(
  previous: Criterion,
  next: Criterion,
): boolean {
  return (
    previous.criterionId === next.criterionId &&
    PROVISIONAL_VERDICTS.has(previous.verdict) &&
    FINAL_VERDICTS.has(next.verdict) &&
    next.evidenceRefs.some((id) => !previous.evidenceRefs.includes(id))
  );
}
