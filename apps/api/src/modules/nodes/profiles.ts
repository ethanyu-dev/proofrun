import { profileFailure } from './profile-failure.js';
import { Database } from '../../db.js';
import { ApiError } from '../../domain.js';
import { executionContext, stopExecution } from '../scheduling/state.js';

/** 只等待关闭证据，不将超时等同于已释放资源。 */
const CLOSE_WAIT_MS = 20_000;

/** 内部生命周期事实；公开返回不包含执行凭据或人工链接凭据。 */
interface ProfileSession {
  /** 维护会话与人工操作入口的内部身份。 */
  id: string;
  /** 复用调度状态机的内部任务，不进入业务列表。 */
  task_id: string;
  /** 历史维护会话所属节点，关闭命令必须路由回原节点。 */
  node_id: string;
  /** 命令与租约绑定的执行身份。 */
  execution_id: string;
  /** 创建时指定的首次导航地址。 */
  url: string;
  /** 固定维护截止时间，重连不延长。 */
  expires_at: Date;
  /** 维护是否仍允许操作。 */
  task_state: string;
  /** 节点资源生命周期状态。 */
  session_state: string;
  /** 只有物理关闭证据才能释放容量。 */
  closure_verified: boolean;
  /** 确定的模板发布回执；空值不宣称已保存。 */
  save_status: 'saved' | 'newer' | null;
  /** 任务失败码与物理关闭原因分别保留，避免把异常退出展示为用户主动关闭。 */
  task_error: { code?: string } | null;
  close_reason: string | null;
}

/** 只读取或关闭历史模板维护会话；不再创建会话或发布模板。 */
export class NodeProfiles {
  constructor(private readonly db: Database) {}

  /** 模板写入入口已停用；历史状态与关闭入口继续可用。 */
  async create(nodeId: string, raw: unknown) {
    throw new ApiError(
      410,
      'NODE_PROFILE_RETIRED',
      '节点默认模板已停用，请配置测试身份来源',
    );
  }

  /** 所有读写均重新查持久归属；此方法只能由 Console 鉴权后的入口调用。 */
  private async read(id: string): Promise<ProfileSession> {
    const row = (
      await this.db.query<ProfileSession>(
        `SELECT p.*,e.id AS execution_id,t.definition->'target'->>'url' AS url,h.expires_at,t.state AS task_state,s.state AS session_state,s.closure_verified,t.error AS task_error,s.close_reason FROM pr_node_profiles p JOIN pr_tasks t ON t.id=p.task_id JOIN pr_executions e ON e.task_id=t.id JOIN pr_sessions s ON s.execution_id=e.id JOIN pr_interventions h ON h.id=p.id WHERE p.id=$1`,
        [id],
      )
    ).rows[0];
    if (!row)
      throw new ApiError(404, 'NODE_PROFILE_MISSING', '节点模板维护会话不存在');
    return row;
  }

  /** 查找尚未关闭的历史维护会话；容量以关闭确认为准。 */
  async current(nodeId: string) {
    const row = (
      await this.db.query(
        `SELECT p.id FROM pr_node_profiles p JOIN pr_executions e ON e.task_id=p.task_id JOIN pr_sessions s ON s.execution_id=e.id WHERE p.node_id=$1 AND NOT s.closure_verified ORDER BY p.created_at DESC LIMIT 1`,
        [nodeId],
      )
    ).rows[0];
    return { id: row?.id ?? null };
  }

  /** 状态读取不提交浏览器操作，页面刷新不会改变远端网址。 */
  async status(id: string) {
    const row = await this.read(id);
    let ready = false;
    let failure = ['ERROR', 'TIMED_OUT'].includes(row.task_state)
      ? profileFailure(
          row.task_error?.code ?? 'NODE_PROFILE_FAILED',
          row.close_reason,
        )
      : null;
    if (row.task_state === 'RUNNING' && row.session_state === 'ACTIVE') {
      const receipt =
        (
          await this.db.query('SELECT result FROM pr_commands WHERE id=$1', [
            `node-profile-open-${id}`,
          ])
        ).rows[0] ?? {};
      ready = receipt.result?.operationStatus === 'SUCCEEDED';
      if (receipt.result && !ready)
        failure = profileFailure(
          receipt.result.error?.code ?? 'NODE_PROFILE_NAVIGATION',
          row.close_reason,
        );
    }
    return {
      id: row.id,
      nodeId: row.node_id,
      url: row.url,
      expiresAt: row.expires_at.toISOString(),
      ready,
      closed: row.closure_verified,
      closing: row.task_state !== 'RUNNING',
      saveStatus: row.save_status,
      failure,
      // 关闭命令回执可能先于 session.closed 到达；容量释放不代表诊断信息已经完整。
      failureDetailsPending: Boolean(failure && !row.close_reason),
    };
  }

  /** 历史会话只允许撤权和关闭，不能再发布模板。 */
  async finish(id: string, wait = true) {
    const row = await this.read(id);
    await this.db.transaction(async (client) => {
      const context = await executionContext(client, row.execution_id);
      if (context.task_state === 'RUNNING')
        await stopExecution(
          client,
          context,
          'CANCELLED',
          'NODE_PROFILE_CLOSED',
        );
    });
    if (wait) await this.waitClosed(id);
  }

  /** 断线后只等待原关闭结果，不再次发布；未知关闭仍保留节点容量。 */
  async waitClosed(id: string) {
    const until = Date.now() + CLOSE_WAIT_MS;
    for (;;) {
      const row = await this.read(id);
      if (row.closure_verified) {
        await this.db.query(
          'UPDATE pr_interventions SET completed_at=COALESCE(completed_at,clock_timestamp()) WHERE id=$1',
          [id],
        );
        return row.save_status;
      }
      if (Date.now() >= until)
        throw new ApiError(
          409,
          'NODE_PROFILE_CLOSING',
          '正在等待浏览器关闭确认，请重新连接查看状态',
        );
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}
