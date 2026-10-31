/** 平台错误只按已知分类输出，不能将远端正文或变量值直接写入 CI 日志。 */
const BACKUP_LIMIT = /^Plan limit of (\d{1,6}) backups per volume exceeded$/;
/** 只允许稳定错误码，未知字段可能夹带请求数据。 */
const ERROR_CODES = new Set([
  'BAD_USER_INPUT',
  'UNAUTHENTICATED',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'INTERNAL_SERVER_ERROR',
  'RATE_LIMITED',
  'TOO_MANY_REQUESTS',
]);
/** 仅保留已知诊断和数字追踪号；原始错误对象不会作为 cause 或正文泄露。 */
export function railwayGraphqlFailure(stage, errors) {
  const details = errors.slice(0, 5).map((error) => {
    const limit = BACKUP_LIMIT.exec(error?.message ?? '');
    let reason = limit
      ? `每卷备份数量已达到套餐上限 ${limit[1]}；需确认清理旧备份或由平台提高额度，不能跳过发布前备份`
      : /^(Not Authorized|Unauthorized|Forbidden)$/i.test(error?.message ?? '')
        ? '权限不足，请核对项目令牌的环境范围'
        : '平台拒绝请求';
    if (ERROR_CODES.has(error?.extensions?.code))
      reason += `；code=${error.extensions.code}`;
    if (typeof error?.traceId === 'string' && /^\d{1,32}$/.test(error.traceId))
      reason += `；traceId=${error.traceId}`;
    return reason;
  });
  return new Error(`Railway ${stage}：${details.join('；')}；停止发布`);
}
