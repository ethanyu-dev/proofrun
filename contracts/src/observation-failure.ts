/** DOM 读写共用错误分类，读取失败也可能带未知效果；只豁免明确的只读命令与故障码。 */
export function recoverableObservationFailure(
  kind: string,
  result: { operationStatus: string; error?: { code: string } },
): boolean {
  return (
    kind === 'browser.observe' &&
    ['UNKNOWN', 'FAILED'].includes(result.operationStatus) &&
    result.error?.code === 'DOM_ENGINE_FAILED'
  );
}

/** 节点明确收到聚焦结果且尚未发送按键；保留聚焦副作用标志，只允许重新观察后决策。 */
export function recoverableFocusFailure(
  operation: { type: string; action?: string; target?: string },
  result: {
    operationStatus: string;
    effect: string;
    error?: { code: string };
    data?: Record<string, unknown>;
  },
): boolean {
  const keyboard = result.data?.keyboard as
    { keyDispatched?: boolean; focusAttempted?: boolean } | undefined;
  return (
    operation.type === 'browser.act' &&
    operation.action === 'press' &&
    typeof operation.target === 'string' &&
    operation.target.length > 0 &&
    result.operationStatus === 'UNKNOWN' &&
    result.effect === 'MAY_HAVE_HAPPENED' &&
    result.error?.code === 'KEYBOARD_FOCUS_UNCONFIRMED' &&
    keyboard?.keyDispatched === false &&
    keyboard.focusAttempted === true
  );
}
