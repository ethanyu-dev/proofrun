import type { ExecutionOutcome, TaskDetail } from '@proofrun/contracts';
import { Status, time } from './ui';

/** 主动阻塞、决策不合规与供应商故障分开显示；请求页和详情共用历史分类兼容。 */
export function OutcomeStatus({ outcome }: { outcome: ExecutionOutcome }) {
  return (
    <Status
      value={
        outcome.category === 'MODEL_ERROR' &&
        outcome.reasonCode === 'MODEL_BLOCKED'
          ? 'EXECUTION_BLOCKED'
          : outcome.category === 'MODEL_ERROR' &&
              outcome.reasonCode === 'INVALID_MODEL_DECISION'
            ? outcome.reasonCode
            : outcome.category
      }
    />
  );
}

/** 分类来自控制面的事实投影；旧响应缺失时继续兼容原生命周期。 */
export function TaskExecutionStatus({ task }: { task: TaskDetail }) {
  if (task.executionOutcome)
    return <OutcomeStatus outcome={task.executionOutcome} />;
  const execution = task.executions[0];
  if (
    task.state === 'RUNNING' &&
    execution?.control_mode &&
    execution.control_mode !== 'AUTO'
  )
    return <Status value="WAITING_HUMAN" />;
  if (task.report?.executionDetails?.reasonCode === 'ENVIRONMENT_NOT_READY')
    return <Status value="ENVIRONMENT_NOT_READY" />;
  return (
    <Status
      value={
        task.report?.executionDisposition === 'BLOCKED' ? 'BLOCKED' : task.state
      }
    />
  );
}

/** 结束机制与原始阻塞分别解释；未知历史事件明确标记未知，避免把清理超时当成根因。 */
export const EXECUTION_REASONS: Record<string, string> = {
  HUMAN_INTERVENTION_TIMEOUT: '超过人工处理等待期限',
  SESSION_ENDED: '会话已结束，旧节点未记录具体触发原因',
  SESSION_CLOSE_REQUESTED: '收到控制面关闭请求',
  SESSION_LEASE_EXPIRED: '浏览器会话租约到期',
  SESSION_START_FAILED: '浏览器会话启动失败',
  SESSION_COMMAND_TIMEOUT: '执行中的浏览器命令超时，会话被回收',
  SESSION_OPERATION_FAILED: '会话因浏览器操作故障关闭',
  NODE_SHUTDOWN: '节点停止，关闭现存会话',
  NODE_RESTART_RECOVERY: '节点启动或重启恢复时回收遗留会话',
  HOST_EXITED: '浏览器监管进程退出',
  HOST_CHANNEL_CLOSED: '浏览器监管通信中断',
  UNKNOWN: '关闭触发原因未知',
  AGENT_ERROR: '执行器提交异常报告，具体原因见原因码',
  WORKER_LEASE_EXPIRED: '执行器失联，租约到期',
};
export function ExecutionOutcomeDetails({
  outcome,
}: {
  outcome?: ExecutionOutcome | undefined;
}) {
  if (!outcome || ['QUEUED', 'RUNNING', 'COMPLETED'].includes(outcome.category))
    return null;
  return (
    <section aria-label="执行原因">
      <h3>执行原因</h3>
      <dl className="facts">
        <div>
          <dt>原因分类</dt>
          <dd>
            <OutcomeStatus outcome={outcome} />
          </dd>
        </div>
        <div>
          <dt>原因码</dt>
          <dd>{outcome.reasonCode ?? '未记录'}</dd>
        </div>
        {outcome.terminationCode && (
          <div>
            <dt>结束原因</dt>
            <dd>
              {EXECUTION_REASONS[outcome.terminationCode] ??
                outcome.terminationCode}
            </dd>
          </div>
        )}
        {outcome.waitingSince && (
          <div>
            <dt>开始等待人工</dt>
            <dd>{time(outcome.waitingSince)}</dd>
          </div>
        )}
        {outcome.waitDeadline && (
          <div>
            <dt>人工等待截止</dt>
            <dd>{time(outcome.waitDeadline)}</dd>
          </div>
        )}
      </dl>
      {outcome.category === 'HUMAN_UNEXECUTABLE' && outcome.detail && (
        <p className="error-notice">{outcome.detail}</p>
      )}
      {outcome.detail && outcome.category !== 'HUMAN_UNEXECUTABLE' && (
        <details>
          <summary>原始阻塞原因</summary>
          <p>{outcome.detail}</p>
        </details>
      )}
    </section>
  );
}
