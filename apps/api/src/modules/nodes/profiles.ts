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
import { interventionToken } from '../scheduling/hitl-token.js';
import type { PoolClient } from 'pg';

/** 维护授权固定三十分钟；节点仍依赖短租约续期，控制面失联时不能继续操作。 */
const MAINTENANCE_MS = 30 * 60_000;
/** 完整目录复制与浏览器启动共用的准入期限。 */
const OPEN_MS = 120_000;

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
    let parsed: URL;
    try {
      parsed = new URL(input.url);
    } catch {
      throw new ApiError(422, 'INVALID_PROFILE_URL', '请输入有效网址');
    }
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password
    )
      throw new ApiError(
        422,
        'INVALID_PROFILE_URL',
        '仅支持不带凭据的 HTTP/HTTPS 网址',
      );
    const url = parsed.href;
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
        heartbeat.capabilities.nodeDefaultProfileVersion !== 1 ||
        !heartbeat.capabilities.directHitl ||
        !heartbeat.publicUrl ||
        !heartbeat.capabilities.liveView ||
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
      if (!heartbeat.admission?.accepting)
        throw new ApiError(409, 'NODE_CAPACITY', '节点当前不接收新会话');
      if (
        (
          await client.query(
            "SELECT 1 FROM pr_sessions WHERE node_id=$1 AND state='OPENING'",
            [nodeId],
          )
        ).rowCount
      )
        throw new ApiError(409, 'NODE_BUSY', '节点正在启动会话，请稍后重试');
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
          null,
          heartbeat.runtime ?? null,
        ],
      );
      await client.query(
        "INSERT INTO pr_interventions(id,execution_id,revision,token_hash,items,expires_at) VALUES($1,$2,1,$3,'[]',$4)",
        [
          id,
          executionId,
          digest(interventionToken(this.config.adminToken, id)),
          expires,
        ],
      );
      await client.query(
        'INSERT INTO pr_node_profiles(id,task_id,node_id,managed) VALUES($1,$2,$3,true)',
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
            profileMode: 'maintenance',
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

  /** 查询只读取持久事实，不能因页面刷新重放导航或发布。 */
  private async read(id: string, query: Pick<Database, 'query'> = this.db) {
    const row = (
      await query.query(
        `SELECT p.*,e.id AS execution_id,t.definition->'target'->>'url' AS url,
       h.expires_at,t.state AS task_state,s.id AS session_id,s.state AS session_state,
       s.closure_verified,t.error,s.close_reason,n.default_profile
       FROM pr_node_profiles p JOIN pr_tasks t ON t.id=p.task_id
       JOIN pr_executions e ON e.task_id=t.id JOIN pr_sessions s ON s.execution_id=e.id
       JOIN pr_interventions h ON h.id=p.id JOIN pr_nodes n ON n.id=p.node_id WHERE p.id=$1`,
        [id],
      )
    ).rows[0];
    if (!row)
      throw new ApiError(404, 'NODE_PROFILE_MISSING', '节点维护会话不存在');
    return row;
  }

  /** 每个节点至多一个未物理关闭的维护会话，重复点击返回原入口。 */
  async current(nodeId: string) {
    const row = (
      await this.db.query(
        `SELECT p.id FROM pr_node_profiles p JOIN pr_executions e ON e.task_id=p.task_id
       JOIN pr_sessions s ON s.execution_id=e.id WHERE p.node_id=$1 AND NOT s.closure_verified
       ORDER BY p.created_at DESC LIMIT 1`,
        [nodeId],
      )
    ).rows[0];
    return { id: row?.id ?? null };
  }

  /** 管理员可取回原 HITL 链接；普通状态不包含节点和执行凭据。 */
  async status(id: string) {
    const row = await this.read(id);
    const navigation = (
      await this.db.query('SELECT result FROM pr_commands WHERE id=$1', [
        `node-profile-open-${id}`,
      ])
    ).rows[0];
    return {
      id,
      taskId: row.task_id,
      nodeId: row.node_id,
      managed: row.managed,
      url: row.url,
      expiresAt: row.expires_at.toISOString(),
      ready:
        navigation?.result?.operationStatus === 'SUCCEEDED' &&
        row.task_state === 'RUNNING' &&
        row.publish_state === 'IDLE',
      closed: row.closure_verified,
      closing: row.task_state !== 'RUNNING',
      publishState: row.publish_state,
      profile: row.published_profile,
      failureCode: row.failure_code ?? row.error?.code ?? null,
      path: row.managed
        ? `/#/hitl/${id}/${interventionToken(this.config.adminToken, id)}`
        : null,
    };
  }

  /** 人工完成只持久化发布意图，由统一命令队列交付；重复事件不重复发布。 */
  async complete(client: PoolClient, id: string, discard = false) {
    let row = (
      await client.query(
        'SELECT * FROM pr_node_profiles WHERE id=$1 AND managed',
        [id],
      )
    ).rows[0];
    if (!row) return false;
    const execution = (
      await client.query('SELECT id FROM pr_executions WHERE task_id=$1', [
        row.task_id,
      ])
    ).rows[0];
    const context = await executionContext(client, execution.id);
    row = (
      await client.query(
        'SELECT * FROM pr_node_profiles WHERE id=$1 FOR UPDATE',
        [id],
      )
    ).rows[0];
    if (row.publish_state !== 'IDLE' || context.task_state !== 'RUNNING')
      return true;
    if (discard) {
      await client.query(
        "UPDATE pr_node_profiles SET publish_state='DISCARDED' WHERE id=$1",
        [id],
      );
      await stopExecution(
        client,
        context,
        'CANCELLED',
        'NODE_PROFILE_DISCARDED',
      );
    } else {
      await client.query(
        "UPDATE pr_node_profiles SET publish_state='SAVING' WHERE id=$1",
        [id],
      );
      await insertCommand(
        client,
        context.id,
        envelope(
          context,
          { type: 'session.profile.publish' },
          OPEN_MS,
          `node-profile-save-${id}`,
        ),
      );
    }
    return true;
  }

  /** 放弃操作不发布模板；已提交保存时只允许查询，避免把未知保存当成取消成功。 */
  async close(id: string) {
    const row = await this.read(id);
    if (!row.managed) {
      await this.coordinator.cancel(row.task_id);
      return;
    }
    if (row.publish_state === 'SAVING')
      throw new ApiError(409, 'NODE_PROFILE_SAVING', '正在保存，请等待结果');
    await this.db.transaction(async (client) => {
      await this.complete(client, id, true);
    });
  }

  /** 启动、发布和关闭由后台恢复推进，不依赖页面连接存活。 */
  async tick() {
    // 已就绪的人工会话无需扫描，避免长期占满批次而饿死后续节点的启动或保存。
    const rows = await this.db.query(
      `SELECT p.id FROM pr_node_profiles p JOIN pr_executions e ON e.task_id=p.task_id
       JOIN pr_sessions s ON s.execution_id=e.id JOIN pr_tasks t ON t.id=p.task_id WHERE p.managed AND
       (p.publish_state='SAVING' OR
        (p.publish_state='IDLE' AND t.state='RUNNING' AND s.state='ACTIVE' AND NOT EXISTS(
          SELECT 1 FROM pr_commands c WHERE c.id='node-profile-open-' || p.id AND c.result->>'operationStatus'='SUCCEEDED')) OR
        (p.publish_state='FAILED' AND EXISTS(SELECT 1 FROM pr_nodes n WHERE n.id=p.node_id AND n.default_profile->>'sessionId'=s.id)))
       ORDER BY p.created_at LIMIT 32`,
    );
    for (const item of rows.rows) {
      await this.db.transaction(async (client) => {
        const initial = await this.read(item.id, client);
        const context = await executionContext(client, initial.execution_id);
        const row = await this.read(item.id, client);
        if (
          row.publish_state === 'SAVING' ||
          (row.publish_state === 'FAILED' &&
            row.default_profile?.sessionId === row.session_id)
        ) {
          const receipt = (
            await client.query('SELECT result FROM pr_commands WHERE id=$1', [
              `node-profile-save-${row.id}`,
            ])
          ).rows[0]?.result;
          const profile =
            receipt?.operationStatus === 'SUCCEEDED'
              ? receipt.data?.profile
              : row.default_profile?.sessionId === row.session_id
                ? row.default_profile
                : undefined;
          if (profile?.sessionId === row.session_id) {
            await client.query(
              "UPDATE pr_node_profiles SET publish_state='SAVED',save_status='saved',published_profile=$2,failure_code=NULL WHERE id=$1",
              [row.id, profile],
            );
            if (context.task_state === 'RUNNING')
              await stopExecution(
                client,
                context,
                'COMPLETED',
                'NODE_PROFILE_SAVED',
              );
          } else if (receipt || context.task_state !== 'RUNNING') {
            await client.query(
              "UPDATE pr_node_profiles SET publish_state='FAILED',failure_code=$2 WHERE id=$1",
              [
                row.id,
                receipt?.error?.code ??
                  row.error?.code ??
                  'PROFILE_SAVE_UNCONFIRMED',
              ],
            );
            if (context.task_state === 'RUNNING')
              await stopExecution(
                client,
                context,
                'ERROR',
                'PROFILE_SAVE_FAILED',
              );
          }
          return;
        }
        if (
          context.task_state !== 'RUNNING' ||
          context.session_state !== 'ACTIVE' ||
          row.publish_state !== 'IDLE'
        )
          return;
        const navigation = (
          await client.query('SELECT result FROM pr_commands WHERE id=$1', [
            `node-profile-open-${row.id}`,
          ])
        ).rows[0]?.result;
        // 初始导航失败不能一直伪装为正在启动；关闭本次维护并保留旧模板。
        if (navigation && navigation.operationStatus !== 'SUCCEEDED') {
          await stopExecution(
            client,
            context,
            'ERROR',
            navigation.error?.code ?? 'PROFILE_NAVIGATION_FAILED',
          );
          return;
        }
        const controlId = `node-profile-control-${row.id}`;
        const control = (
          await client.query('SELECT result FROM pr_commands WHERE id=$1', [
            controlId,
          ])
        ).rows[0];
        if (!control) {
          await insertCommand(
            client,
            context.id,
            envelope(
              context,
              { type: 'session.control', mode: 'HUMAN', revision: 1 },
              10_000,
              controlId,
            ),
          );
        } else if (
          control.result?.operationStatus === 'SUCCEEDED' &&
          !(
            await client.query('SELECT 1 FROM pr_commands WHERE id=$1', [
              `node-profile-open-${row.id}`,
            ])
          ).rowCount
        ) {
          await insertCommand(
            client,
            context.id,
            envelope(
              context,
              { type: 'browser.act', action: 'navigate', target: row.url },
              30_000,
              `node-profile-open-${row.id}`,
            ),
          );
        }
      });
    }
  }
}
