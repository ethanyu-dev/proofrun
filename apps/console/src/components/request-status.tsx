import { Status } from './ui';

/** 汇总无法判定还包含取消、缺报告和阻塞，不能一律称为证据不足。 */
export function RequestStatus({ value }: { value: string | null | undefined }) {
  return value === 'INCONCLUSIVE' ? (
    <span className="status" data-tone="warning">
      无法判定
    </span>
  ) : (
    <Status value={value} />
  );
}
