import { randomUUID } from 'node:crypto';
import type { VerificationTask } from '@proofrun/contracts';
import { Database } from '../../db.js';
import {
  ApiError,
  canonical,
  digest,
  MAX_FENCE,
  newToken,
} from '../../domain.js';
import type { ApiConfig } from '../../config.js';
import { Coordinator } from '../scheduling/coordinator.js';
import {
  envelope,
  executionContext,
  insertCommand,
  stopExecution,
} from '../scheduling/state.js';
import { validateHitlNavigation } from '../hitl/navigation.js';

/** 维护授权固定三十分钟；节点仍依赖短租约续期，控制面失联时不能继续操作。 */
const MAINTENANCE_MS = 30 * 60_000;
/** 完整目录复制与浏览器启动共用的准入期限。 */
const OPEN_MS = 120_000;
/** 只等待关闭证据，不将超时等同于已释放资源。 */
const CLOSE_WAIT_MS = 20_000;
/** 与节点保留槽位一致，不接受用户指定路径或身份基准。 */
const TEMPLATE_SLOT = 'node-default-template';

/** 内部生命周期事实；公开返回不包含执行凭据或人工链接凭据。 */
interface ProfileSession {
  /** 维护会话与人工操作入口的内部身份。 */
  id: string;
  /** 复用调度状态机的内部任务，不进入业务列表。 */
  task_id: string;
  /** 模板所属节点，不能迁移到其他节点保存。 */
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
}

/** Console 维护入口只编排人工会话，复用调度器的容量、持久命令、撤权与物理关闭语义。 */
export class NodeProfiles {
  constructor(
    private readonly db: Database,
    private readonly config: ApiConfig,
    private readonly coordinator: Coordinator,
  ) {}

  /** 同一节点已有未关闭维护会话时返回它，避免刷新或重复点击创建多个模板编辑副本。 */
  async create(nodeId: string, raw: unknown) {
    const input = raw as { url?: unknown } | null;
    if (
      !input ||
      typeof input.url !== 'string' ||
      Object.keys(input).some((k) => k !== 'url') ||
      input.url.length > 8192
    )
      throw new ApiError(422, 'INVALID_PROFILE_URL', '请填写要打开的网页地址');
    validateHitlNavigation({
      type: 'browser.act',
      action: 'navigate',
      target: input.url,
    });
    const url = new URL(input.url).href;
    const id = await this.db.transaction(async (client) => {
      const node = (
        await client.query(
          'SELECT * FROM pr_nodes WHERE id=$1 FOR NO KEY UPDATE',
          [nodeId],
        )
      ).rows[0];
      if (!node || node.revoked_at)
        throw new ApiError(404, 'NODE_MISSING', '节点不存在或已撤销');
      const existing = (
        await client.query(
          `SELECT p.id FROM pr_node_profiles p JOIN pr_executions e ON e.task_id=p.task_id JOIN pr_sessions s ON s.execution_id=e.id WHERE p.node_id=$1 AND NOT s.closure_verified`,
          [nodeId],
        )
      ).rows[0];
      if (existing) return existing.id as string;
      const connection = this.coordinator.gateway
        .live()
        .find(
          (c) =>
            c.nodeId === nodeId && c.heartbeat?.nodeEpoch === node.node_epoch,
        );
      const heartbeat = connection?.heartbeat;
      if (!heartbeat)
        throw new ApiError(409, 'NODE_OFFLINE', '节点不在线，请等待重新连接');
      if (
        !heartbeat.capabilities.nodeProfileManagement ||
        !heartbeat.capabilities.fullProfile ||
        !heartbeat.capabilities.liveView ||
        !heartbeat.capabilities.authState ||
        !heartbeat.capabilities.renewableSessions ||
        !heartbeat.capabilities.writeActions
      )
        throw new ApiError(
          409,
          'NODE_PROFILE_UNSUPPORTED',
          '请升级节点并启用浏览器交互能力后维护默认 profile',
        );
      if (
        (
          await client.query(
            'SELECT 1 FROM pr_pairings WHERE rotate_node_id=$1 AND used_at IS NULL AND expires_at>clock_timestamp()',
            [nodeId],
          )
        ).rowCount
      )
        throw new ApiError(409, 'NODE_ROTATING', '节点正在轮换凭据');
      const reserved = await client.query(
        'SELECT id FROM pr_sessions WHERE node_id=$1 AND NOT closure_verified',
        [nodeId],
      );
      const occupied = new Set([
        ...reserved.rows.map((r) => r.id),
        ...heartbeat.occupied.map((s) => s.sessionId),
      ]);
      if (occupied.size >= Math.min(node.capacity, heartbeat.capacity))
        throw new ApiError(409, 'NODE_CAPACITY', '节点没有空闲浏览器槽位');
      const fence = Number(node.fence) + 1;
      if (fence > MAX_FENCE)
        throw new ApiError(503, 'FENCE_EXHAUSTED', '节点隔离序号已用尽');
      const id = randomUUID();
      const taskId = `node-profile-${id}`;
      const executionId = randomUUID();
      const expires = new Date(Date.now() + MAINTENANCE_MS);
      // 内部资源所有者不会排队或交给 Worker；定义仅供现有命令、期限和关闭机制读取。
      const definition: VerificationTask = {
        protocolVersion: '0.1',
        taskId,
        objective: '维护节点默认 profile',
        target: { url },
        environment: {
          id: 'node-profile',
          nodePool: node.pool,
          allowIntervention: true,
        },
        budget: { timeoutMs: MAINTENANCE_MS, maxActions: 1 },
        acceptanceCriteria: [
          {
            id: 'manual',
            description: '人工维护节点模板',
            expectedResult: '由 Console 用户明确保存或关闭',
            evidenceKinds: ['SCREENSHOT'],
          },
        ],
      };
      const auth = {
        stateId: TEMPLATE_SLOT,
        restore: true,
        restoreIfPresent: true,
        fullProfile: true,
        nodeTemplate: true,
      };
      await client.query('UPDATE pr_nodes SET fence=$2 WHERE id=$1', [
        nodeId,
        fence,
      ]);
      await client.query(
        "INSERT INTO pr_tasks(id,definition,definition_hash,state,deadline_at) VALUES($1,$2,$3,'RUNNING',$4)",
        [taskId, definition, digest(canonical(definition)), expires],
      );
      await client.query(
        "INSERT INTO pr_executions(id,task_id,worker_id,token_hash,lease_expires_at,state,control_mode,control_revision,control_reason,human_deadline_at) VALUES($1,$2,'console-node-profile',$3,$4,'STARTING','HUMAN',1,'维护节点默认 profile',$4)",
        [executionId, taskId, digest(newToken()), expires],
      );
      await client.query(
        "INSERT INTO pr_sessions(id,execution_id,node_id,node_epoch,lease_id,fence,state,last_renew_request,auth_state,node_runtime) VALUES($1,$2,$3,$4,$5,$6,'OPENING',$7,$8,$9)",
        [
          randomUUID(),
          executionId,
          nodeId,
          heartbeat.nodeEpoch,
          randomUUID(),
          fence,
          heartbeat.leaseRequestId,
          auth,
          heartbeat.runtime ?? null,
        ],
      );
      await client.query(
        "INSERT INTO pr_interventions(id,execution_id,revision,token_hash,items,expires_at) VALUES($1,$2,1,$3,'[]',$4)",
        [id, executionId, digest(newToken()), expires],
      );
      await client.query(
        'INSERT INTO pr_node_profiles(id,task_id,node_id) VALUES($1,$2,$3)',
        [id, taskId, nodeId],
      );
      const context = await executionContext(client, executionId);
      await insertCommand(
        client,
        executionId,
        envelope(
          context,
          {
            type: 'session.open',
            authState: auth,
            liveView: true,
            renewable: true,
            leaseRequestId: heartbeat.leaseRequestId,
            leaseTtlMs: Math.min(
              this.config.nodeLeaseMs,
              heartbeat.limits.maxLeaseMs,
            ),
            maxDurationMs: Math.min(
              MAINTENANCE_MS,
              heartbeat.limits.maxSessionMs,
            ),
          },
          OPEN_MS,
        ),
      );
      return id;
    });
    return { id };
  }

  /** 所有读写均重新查持久归属；此方法只能由 Console 鉴权后的入口调用。 */
  private async read(id: string): Promise<ProfileSession> {
    const row = (
      await this.db.query<ProfileSession>(
        `SELECT p.*,e.id AS execution_id,t.definition->'target'->>'url' AS url,h.expires_at,t.state AS task_state,s.state AS session_state,s.closure_verified FROM pr_node_profiles p JOIN pr_tasks t ON t.id=p.task_id JOIN pr_executions e ON e.task_id=t.id JOIN pr_sessions s ON s.execution_id=e.id JOIN pr_interventions h ON h.id=p.id WHERE p.id=$1`,
        [id],
      )
    ).rows[0];
    if (!row)
      throw new ApiError(404, 'NODE_PROFILE_MISSING', '节点模板维护会话不存在');
    return row;
  }

  /** 查找当前维护会话，页面刷新后仍可继续或关闭；容量以关闭确认为准。 */
  async current(nodeId: string) {
    const row = (
      await this.db.query(
        `SELECT p.id FROM pr_node_profiles p JOIN pr_executions e ON e.task_id=p.task_id JOIN pr_sessions s ON s.execution_id=e.id WHERE p.node_id=$1 AND NOT s.closure_verified ORDER BY p.created_at DESC LIMIT 1`,
        [nodeId],
      )
    ).rows[0];
    return { id: row?.id ?? null };
  }

  /** 首次导航使用固定命令身份；后台恢复不会重新打开页面或重放人工输入。 */
  async tick() {
    const rows = await this.db.query(
      `SELECT p.id FROM pr_node_profiles p JOIN pr_tasks t ON t.id=p.task_id JOIN pr_executions e ON e.task_id=t.id JOIN pr_sessions s ON s.execution_id=e.id WHERE t.state='RUNNING' AND s.state='ACTIVE' AND NOT EXISTS(SELECT 1 FROM pr_commands c WHERE c.id='node-profile-open-' || p.id) LIMIT 16`,
    );
    for (const item of rows.rows) {
      const row = await this.read(item.id);
      await this.coordinator.command(
        row.execution_id,
        null,
        `node-profile-open-${row.id}`,
        15_000,
        { type: 'browser.act', action: 'navigate', target: row.url },
        1,
      );
    }
  }

  /** 状态读取不提交浏览器操作，页面刷新不会改变远端网址。 */
  async status(id: string) {
    const row = await this.read(id);
    let ready = false;
    if (row.task_state === 'RUNNING' && row.session_state === 'ACTIVE') {
      const receipt =
        (
          await this.db.query('SELECT result FROM pr_commands WHERE id=$1', [
            `node-profile-open-${id}`,
          ])
        ).rows[0] ?? {};
      ready = receipt.result?.operationStatus === 'SUCCEEDED';
      if (receipt.result && !ready)
        throw new ApiError(
          409,
          'NODE_PROFILE_NAVIGATION',
          '初始网页打开失败，请关闭维护会话后重试',
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
    };
  }

  /** 发布回执先持久化，再关闭资源；只有物理关闭确认后才向处理页报告完成。 */
  async finish(id: string, saved?: 'saved' | 'newer', wait = true) {
    const row = await this.read(id);
    await this.db.transaction(async (client) => {
      const context = await executionContext(client, row.execution_id);
      if (saved)
        await client.query(
          'UPDATE pr_node_profiles SET save_status=$2 WHERE id=$1',
          [id, saved],
        );
      if (context.task_state === 'RUNNING')
        await stopExecution(
          client,
          context,
          saved ? 'COMPLETED' : 'CANCELLED',
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
