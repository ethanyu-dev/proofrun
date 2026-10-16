/** 对外只提供稳定错误码与固定说明，不把节点日志、网页内容或登录信息放入维护状态。 */
const FAILURE_MESSAGES: Record<string, string> = {
  SESSION_LEASE_EXPIRED:
    '节点未能在租约到期前完成续租，浏览器已停止。请确认节点连接稳定后重新打开维护会话。',
  SESSION_START_TIMEOUT:
    '恢复 profile 或启动浏览器超过启动时限。请检查节点负载后重新打开维护会话。',
  SESSION_START_FAILED:
    '恢复 profile 或启动浏览器失败。请检查节点浏览器依赖与运行日志。',
  PROFILE_COPY_FAILED:
    '无法复制节点默认 profile。请检查节点磁盘空间与目录权限。',
  PROFILE_STATE_INVALID:
    '节点默认 profile 中的会话状态无效，请检查节点运行日志。',
  COMMAND_DEADLINE_EXCEEDED:
    '浏览器命令未在规定时间内返回结果，操作结果无法确认。',
  SESSION_COMMAND_TIMEOUT:
    '网页操作超过执行时限，浏览器已停止。请检查目标网站连接后重新打开维护会话。',
  DEADLINE_EXCEEDED: '浏览器操作或会话授权已超时，请重新打开维护会话。',
  HUMAN_TIMEOUT: '维护授权已到期，请重新打开维护会话。',
  NODE_RESTARTED: '节点进程已重启，原维护会话不能继续。请重新打开维护会话。',
  HOST_EXITED: '浏览器宿主进程意外退出，请检查节点运行日志。',
  HOST_CHANNEL_CLOSED: '节点与浏览器宿主进程的连接中断，请检查节点运行日志。',
};

/** 节点可能返回未知错误码，仅接受映射表自身的固定说明。 */
function failureMessage(code: string) {
  return Object.hasOwn(FAILURE_MESSAGES, code)
    ? FAILURE_MESSAGES[code]
    : undefined;
}

/** 物理关闭原因比通用操作超时更具体；同时保留原任务错误码供定位。 */
export function profileFailure(errorCode: string, closeReason: string | null) {
  const code =
    closeReason &&
    failureMessage(closeReason) &&
    !(closeReason === 'SESSION_START_FAILED' && failureMessage(errorCode))
      ? closeReason
      : errorCode;
  return {
    code,
    errorCode,
    closeReason,
    message:
      failureMessage(code) ??
      '维护会话执行失败，请根据错误码检查节点日志后重新打开。',
  };
}
