/** 维护页读取的持久状态；故障与保存回执分开，异常关闭不暗示旧模板被删除。 */
export interface NodeProfileStatus {
  /** 初始导航完成后才允许进入交互。 */
  ready: boolean;
  /** 资源已确认物理关闭。 */
  closed: boolean;
  /** 已撤销操作权限，等待资源关闭确认。 */
  closing: boolean;
  /** 本次维护是否确认发布了模板。 */
  saveStatus: 'saved' | 'newer' | null;
  /** 物理关闭回执先到时，仍等待节点的最终关闭原因。 */
  failureDetailsPending?: boolean;
  /** 旧 API 可能不返回故障详情，兼容缺省值。 */
  failure?: {
    code: string;
    errorCode: string;
    closeReason: string | null;
    message: string;
  } | null;
}

/** 使用服务端持久失败事实渲染结果，保留错误码供用户定位。 */
export function NodeProfileOutcome({
  status,
  closing,
}: {
  status: NodeProfileStatus | undefined;
  closing: boolean;
}) {
  return (
    <>
      <h1>
        {status?.failure
          ? '维护会话失败'
          : status?.closed
            ? '维护会话已关闭'
            : status?.closing || closing
              ? '正在关闭浏览器…'
              : '历史维护会话'}
      </h1>
      {status?.failure && (
        <div role="alert">
          <p>{status.failure.message}</p>
          {status.failureDetailsPending && (
            <p>正在同步节点最终失败原因，收到后将自动更新。</p>
          )}
          <p>
            错误码：<code>{status.failure.code}</code>
            {status.failure.errorCode !== status.failure.code && (
              <>
                ；操作错误：<code>{status.failure.errorCode}</code>
              </>
            )}
          </p>
        </div>
      )}
      <p>
        {status?.saveStatus === 'saved'
          ? '本次节点默认 profile 已保存。'
          : status?.saveStatus === 'newer'
            ? '已保留较新的节点默认 profile。'
            : status?.closed || status?.failure
              ? '本次没有确认发布新的节点默认 profile；之前已保存的模板不会因此被删除。'
              : '维护入口已停用，仅保留历史记录与关闭操作。'}
      </p>
      {status?.failure && (
        <p>
          {status.closed
            ? '浏览器已关闭，维护入口已停用。'
            : status.closing
              ? '正在等待浏览器关闭确认。'
              : '请关闭当前遗留维护会话。'}
        </p>
      )}
    </>
  );
}
