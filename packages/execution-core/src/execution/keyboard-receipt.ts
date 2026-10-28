import type { RecentOperation } from './context.js';

/** 仅采用节点确认的按键范围；旧节点和身份不匹配的回执不能证明目标曾取得焦点。 */
export function keyboardReceipt(
  target: string | undefined,
  requestedTargetName: string,
  result: {
    operationStatus: string;
    effect: string;
    data?: Record<string, unknown>;
  },
): Pick<RecentOperation, 'targetName' | 'requestedTargetName' | 'keyboard'> {
  const receipt = result.data?.keyboard as
    { scope?: unknown; target?: unknown; focusVerified?: unknown } | undefined;
  const verified =
    target !== undefined &&
    receipt?.scope === 'target' &&
    receipt.target === target &&
    receipt.focusVerified === true &&
    result.operationStatus === 'SUCCEEDED' &&
    result.effect === 'COMPLETED';
  return {
    ...(target === undefined ? {} : { requestedTargetName }),
    ...(verified ? { targetName: requestedTargetName } : {}),
    keyboard: {
      scope: verified
        ? 'target'
        : target === undefined
          ? 'current-focus'
          : 'unknown',
      focusVerified: verified,
    },
  };
}
