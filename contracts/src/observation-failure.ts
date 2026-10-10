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
