import { executionDeadline, CLEANUP_EXECUTION_MS } from './execution-time.js';
import { inlineCleanup } from '../cases/inline-cleanup.js';
import { summarizeReport } from '@proofrun/contracts';
import { randomUUID } from 'node:crypto';
import {
  validateVerificationTask,
  validateStepResults,
  type StepResult,
} from '@proofrun/contracts';
import {
  cleanupTask,
  expandCaseTasks,
  caseArmIds,
  CASE_TASK_ID,
} from '../cases/structured.js';
import type { PoolClient } from 'pg';
import type {
  NodeCommand,
  NodeEvent,
  VerificationTask,
  VerificationReport,
  QueueReason,
} from '@proofrun/contracts';
import type { ApiConfig } from '../../config.js';
import { Database } from '../../db.js';
import {
  ApiError,
  canonical,
  digest,
  MAX_FENCE,
  newToken,
  type BrowserOperation,
  type CommandResult,
  type Heartbeat,
} from '../../domain.js';
import { authPlacement, recordQueueReason } from './placement.js';
import { cleanupPlacement } from './cleanup-placement.js';
import { sessionAuth } from './auth.js';
import {
  routingSnapshot,
  resolveRoute,
  targetHostname,
} from '../nodes/routing.js';
import { NodeGateway, type Connection } from '../nodes/gateway.js';
import { ArtifactStore } from '../reports/artifacts.js';
import {
  envelope,
  executionContext,
  insertCommand,
  releaseSession,
  stopExecution,
  syntheticResult,
  type ExecutionContext,
} from './state.js';

/** 每轮有界扫描，避免单个节点积压阻塞全部队列。 */
const BATCH_SIZE = 64;
/** 未确认命令仅使用原身份重送，不能生成新身份重放业务动作。 */
const DELIVERY_INTERVAL_MS = 2000;
/** 清理重试频率独立于业务执行；隔离状态不自动解锁。 */
const CLEANUP_RETRY_MS = 5000;
/** 上层任务的最长总预算，包括排队时间。 */
const MAX_TASK_MS = 86_400_000;

/** 控制面协调器：事务只改变事实，传输由独立投递循环完成。 */
export class Coordinator {
  /** 在应用装配时注入唯一网关，避免建立第二套路由状态。 */
  gateway!: NodeGateway;
  constructor(
    private readonly db: Database,
    private readonly config: ApiConfig,
    private readonly artifacts: ArtifactStore,
  ) {}

  /** 接收上层定义的任务快照；相同身份只允许相同定义。 */
  async submit(task: VerificationTask) {
    if (
      task.steps ||
      task.cleanupStepIds !== undefined ||
      task.caseV2Definition ||
      task.purpose === 'cleanup' ||
      CASE_TASK_ID.test(task.taskId)
    )
      throw new ApiError(
        400,
        'CASE_ENDPOINT_REQUIRED',
        '结构化 case 请通过 /v2/cases 提交',
      );
    if (task.comparison)
      throw new ApiError(
        400,
        'COMPARISON_ENDPOINT_REQUIRED',
        '请通过任务并行对比入口创建两组任务',
      );
    const ids = task.acceptanceCriteria.map((c) => c.id);
    if (
      new Set(ids).size !== ids.length ||
      task.budget.timeoutMs > MAX_TASK_MS ||
      task.budget.maxActions > 10_000
    )
      throw new ApiError(
        422,
        'INVALID_TASK',
        'Duplicate criteria or excessive budget',
      );
    if (
      task.acceptanceCriteria.some((c) =>
        c.evidenceKinds.some(
          (kind) => !['DOM', 'SCREENSHOT', 'NETWORK', 'TRACE'].includes(kind),
        ),
      )
    )
      throw new ApiError(
        422,
        'UNSUPPORTED_EVIDENCE',
        'This release supports DOM, SCREENSHOT, NETWORK and TRACE evidence',
      );
    if (task.executionMode === 'parallel') {
      if (task.taskId.length > 100)
        throw new ApiError(
          422,
          'INVALID_TASK',
          '并行任务 ID 最长为 100 个字符',
        );
      const tasks = this.comparisonTasks(task, task.taskId, task.taskId);
      await this.enqueue(tasks, task.taskId);
      return this.task(tasks[0]!.taskId);
    }
    await this.enqueue([task], task.taskId);
    return this.task(task.taskId);
  }

  /** 同一提交身份跨模式互斥；整批事务回滚，不能在第二组冲突时遗留第一组。 */
  private async enqueue(tasks: VerificationTask[], identity: string) {
    await this.db.transaction(async (client) => {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [identity],
      );
      const bound = await client.query<{ id: string }>(
        "SELECT id FROM pr_tasks WHERE id=$1 OR definition->'comparison'->>'id'=$1",
        [identity],
      );
      if (
        bound.rows.some((row) => !tasks.some((task) => task.taskId === row.id))
      )
        throw new ApiError(
          409,
          'TASK_CONFLICT',
          '任务身份已绑定另一种执行方式',
        );
      for (const task of tasks) {
        const hash = digest(canonical(task));
        await client.query(
          `INSERT INTO pr_tasks(id,definition,definition_hash,state,deadline_at)
          VALUES($1,$2,$3,'QUEUED',clock_timestamp()+$4*interval '1 millisecond') ON CONFLICT(id) DO NOTHING`,
          [task.taskId, task, hash, task.budget.timeoutMs],
        );
        const existing = await client.query(
          'SELECT definition_hash FROM pr_tasks WHERE id=$1',
          [task.taskId],
        );
        if (existing.rows[0]?.definition_hash !== hash)
          throw new ApiError(
            409,
            'TASK_CONFLICT',
            'Task identity already binds another definition',
          );
      }
    });
  }

  /** 整批原子入队；锁按身份排序，交叉批次不会因请求顺序形成死锁。 */
  async submitCaseBatch(tasks: VerificationTask[]) {
    await this.db.transaction(async (client) => {
      for (const task of [...tasks].sort((a, b) =>
        a.taskId.localeCompare(b.taskId),
      )) {
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [task.taskId],
        );
      }
      for (const task of tasks) {
        if (
          !validateVerificationTask(task) ||
          !task.caseV2Definition ||
          task.budget.timeoutMs > MAX_TASK_MS ||
          task.budget.maxActions > 10000
        )
          throw new ApiError(422, 'INVALID_CASE', '任务定义或预算无效');
        const existing = (
          await client.query('SELECT definition FROM pr_tasks WHERE id=$1', [
            task.taskId,
          ])
        ).rows[0];
        if (existing) {
          if (
            canonical(existing.definition.caseV2Definition) !==
            canonical(task.caseV2Definition)
          )
            throw new ApiError(409, 'CASE_CONFLICT', 'caseId 已绑定另一份定义');
          continue;
        }
        const source = task;
        for (const task of expandCaseTasks(source)) {
          if (!validateVerificationTask(task))
            throw new ApiError(422, 'INVALID_CASE', '双跑任务定义无效');
          await client.query(
            `INSERT INTO pr_tasks(id,definition,definition_hash,state,deadline_at)
          VALUES($1,$2,$3,'QUEUED',clock_timestamp()+$4*interval '1 millisecond')`,
            [task.taskId, task, digest(canonical(task)), task.budget.timeoutMs],
          );
          const cleanup = cleanupTask(task);
          if (cleanup)
            await client.query(
              'INSERT INTO pr_case_cleanups(parent_task_id,task_id,definition) VALUES($1,$2,$3)',
              [task.taskId, cleanup.taskId, cleanup],
            );
        }
      }
    });
  }

  /** 优先投影同任务收尾；历史独立清理仍从关联表读取。 */
  async caseCleanup(id: string): Promise<{
    taskId: string;
    status:
      | 'PENDING'
      | 'QUEUED'
      | 'SKIPPED'
      | 'RUNNING'
      | 'COMPLETED'
      | 'CANCELLED'
      | 'TIMED_OUT'
      | 'ERROR';
    report: VerificationReport | null;
  } | null> {
    const parent = (
      await this.db.query<{
        definition: VerificationTask;
        state: string;
        report: VerificationReport | null;
        stepResults: StepResult[] | null;
      }>(
        'SELECT definition,state,report,step_results AS "stepResults" FROM pr_tasks WHERE id=$1',
        [id],
      )
    ).rows[0];
    if (parent?.definition.cleanupStepIds !== undefined)
      return inlineCleanup(parent);
    return (
      (
        await this.db.query<{
          taskId: string;
          status: NonNullable<
            Awaited<ReturnType<Coordinator['caseCleanup']>>
          >['status'];
          report: VerificationReport | null;
        }>(
          `SELECT c.task_id AS "taskId",coalesce(t.state,c.state) AS status,t.report
      FROM pr_case_cleanups c LEFT JOIN pr_tasks t ON t.id=c.task_id WHERE c.parent_task_id=$1`,
          [id],
        )
      ).rows[0] ?? null
    );
  }

  /** 仅调度历史独立清理意图；新 case 的收尾由原任务执行器推进。 */
  private async scheduleCaseCleanups() {
    await this.db.transaction(async (client) => {
      const jobs = await client.query(
        `SELECT c.* FROM pr_case_cleanups c JOIN pr_tasks p ON p.id=c.parent_task_id
        WHERE c.state='PENDING' AND p.state NOT IN ('QUEUED','RUNNING')
        AND NOT EXISTS(SELECT 1 FROM pr_executions e JOIN pr_sessions s ON s.execution_id=e.id WHERE e.task_id=p.id AND NOT s.closure_verified)
        ORDER BY p.created_at LIMIT $1 FOR UPDATE OF c SKIP LOCKED`,
        [BATCH_SIZE],
      );
      for (const job of jobs.rows) {
        const executed = await client.query(
          'SELECT 1 FROM pr_executions WHERE task_id=$1',
          [job.parent_task_id],
        );
        if (!executed.rowCount) {
          await client.query(
            "UPDATE pr_case_cleanups SET state='SKIPPED' WHERE parent_task_id=$1",
            [job.parent_task_id],
          );
          continue;
        }
        const definition = job.definition as VerificationTask;
        await client.query(
          `INSERT INTO pr_tasks(id,definition,definition_hash,state,deadline_at)
          VALUES($1,$2,$3,'QUEUED',clock_timestamp()+$4*interval '1 millisecond') ON CONFLICT(id) DO NOTHING`,
          [
            definition.taskId,
            definition,
            digest(canonical(definition)),
            definition.budget.timeoutMs,
          ],
        );
        const saved = (
          await client.query(
            'SELECT definition_hash FROM pr_tasks WHERE id=$1',
            [definition.taskId],
          )
        ).rows[0];
        if (saved.definition_hash !== digest(canonical(definition)))
          throw new ApiError(
            409,
            'CLEANUP_CONFLICT',
            '清理身份已绑定其他定义，停止自动调度',
          );
        await client.query(
          "UPDATE pr_case_cleanups SET state='QUEUED' WHERE parent_task_id=$1",
          [job.parent_task_id],
        );
      }
    });
  }

  /** 步骤快照随执行令牌写入；只允许当前执行的证据和完整原步骤集合。 */
  async recordSteps(id: string, token: string, input: unknown) {
    if (!validateStepResults(input))
      throw new ApiError(400, 'INVALID_STEPS', '步骤结果格式无效');
    return this.db.transaction(async (client) => {
      const context = await executionContext(client, id);
      this.authorize(context, token, true);
      await this.artifacts.validateSteps(client, context, input);
      const startsCleanup =
        !context.cleanup_deadline_at &&
        input.some(
          (step) =>
            step.status === 'RUNNING' &&
            context.definition.cleanupStepIds?.includes(step.stepId),
        );
      if (startsCleanup) {
        // 与首次 RUNNING 快照原子提交；使用服务端时间，忽略 worker 自报的 startedAt。
        const deadline = new Date(Date.now() + CLEANUP_EXECUTION_MS);
        await client.query(
          'UPDATE pr_tasks SET deadline_at=$2,cleanup_deadline_at=$2 WHERE id=$1',
          [context.task_id, deadline],
        );
        context.deadline_at = deadline;
        context.cleanup_deadline_at = deadline;
        context.lease_expires_at = new Date(
          Math.min(deadline.getTime(), Date.now() + this.config.workerLeaseMs),
        );
        await client.query(
          'UPDATE pr_executions SET lease_expires_at=$2 WHERE id=$1',
          [id, context.lease_expires_at],
        );
      }
      await client.query('UPDATE pr_tasks SET step_results=$2 WHERE id=$1', [
        context.task_id,
        JSON.stringify(input),
      ]);
      return {
        saved: true,
        taskDeadlineAt: context.deadline_at,
        cleanupDeadlineAt: context.cleanup_deadline_at,
        leaseExpiresAt: context.lease_expires_at,
        controlMode: context.control_mode,
        controlRevision: context.control_revision,
      };
    });
  }

  /** 并行组分别携带实际策略，不能继承来源任务的单组模式；两组从同一不可变登录快照启动。 */
  private comparisonTasks(
    definition: VerificationTask,
    id: string,
    sourceTaskId: string,
  ): VerificationTask[] {
    return (['llm', 'jev'] as const).map((arm) => ({
      ...definition,
      taskId: `${id}-${arm}`,
      // 旧对照入口不补写新字段，保证升级后以相同身份重试仍匹配原定义摘要。
      ...(definition.executionMode ? { executionMode: arm } : {}),
      comparison: { id, arm, sourceTaskId },
    }));
  }

  /** 重跑创建独立任务，保留原配置；对照任务成对重建，避免丢失 JEV 执行策略。 */
  async rerun(sourceId: string, runId: string) {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(runId) || runId === sourceId)
      throw new ApiError(400, 'INVALID_RERUN', '重跑需要一个新的有效任务身份');
    const source = await this.task(sourceId);
    const definition = source.definition as VerificationTask;
    if (definition.steps)
      throw new ApiError(
        400,
        'CASE_ENDPOINT_REQUIRED',
        '结构化任务请使用新 caseId 通过 /v2/cases 重提，不支持在内部入口重跑',
      );
    if (definition.comparison) {
      if (runId === definition.comparison.id)
        throw new ApiError(400, 'INVALID_RERUN', '重跑需要新的对照组身份');
      return this.compare(sourceId, runId);
    }
    await this.submit({ ...definition, taskId: runId });
    return { taskId: runId };
  }

  /** 同一事务创建两份不可变任务；幂等身份防止响应丢失后重复运行业务操作。 */
  async compare(sourceId: string, comparisonId: string, maxActions?: number) {
    if (
      !/^[A-Za-z0-9_-]{1,100}$/.test(comparisonId) ||
      CASE_TASK_ID.test(comparisonId)
    )
      throw new ApiError(400, 'INVALID_COMPARISON', '无效的对比身份');
    // 预算变更仅用于本轮两份新任务，原任务定义和历史报告保持不可变。
    if (
      maxActions !== undefined &&
      (!Number.isSafeInteger(maxActions) || maxActions < 1 || maxActions > 1000)
    )
      throw new ApiError(
        400,
        'INVALID_COMPARISON',
        '动作上限必须为 1–1000 的整数',
      );
    const source = await this.task(sourceId);
    const definition = source.definition as VerificationTask;
    if (definition.steps)
      throw new ApiError(
        400,
        'CASE_ENDPOINT_REQUIRED',
        '结构化任务请使用新 caseId 通过 /v2/cases 重提，不支持在内部入口重跑',
      );
    const tasks = this.comparisonTasks(
      {
        ...definition,
        budget: {
          ...definition.budget,
          maxActions: maxActions ?? definition.budget.maxActions,
        },
      },
      comparisonId,
      sourceId,
    );
    await this.enqueue(tasks, comparisonId);
    return { id: comparisonId, taskId: tasks[0]!.taskId };
  }

  /** 组身份由不可变任务定义确定，不允许页面随意拼接另一组执行。 */
  async comparison(taskId: string) {
    const task = await this.task(taskId);
    const group = (task.definition as VerificationTask).comparison;
    if (!group) return { comparison: null };
    return {
      comparison: {
        id: group.id,
        sourceTaskId: group.sourceTaskId,
        arms: await Promise.all(
          (task.definition.caseV2Definition
            ? caseArmIds(task.definition)
            : ['llm', 'jev'].map((arm) => `${group.id}-${arm}`)
          ).map((id) => this.task(id)),
        ),
      },
    };
  }

  /** 返回任务与资源清理进度，避免把终态任务误认为浏览器已关闭。 */
  async task(id: string) {
    const task = (
      await this.db.query<{
        definition: VerificationTask;
        state:
          | 'QUEUED'
          | 'RUNNING'
          | 'COMPLETED'
          | 'CANCELLED'
          | 'TIMED_OUT'
          | 'ERROR';
        report: VerificationReport | null;
        stepResults?: StepResult[] | null;
        queueReason?: QueueReason | null;
        [key: string]: unknown;
      }>(
        'SELECT id,definition,state,deadline_at,report,error,created_at,finished_at,archived_at,step_results AS "stepResults",queue_reason AS "queueReason" FROM pr_tasks WHERE id=$1',
        [id],
      )
    ).rows[0];
    if (!task) throw new ApiError(404, 'TASK_MISSING', 'Task not found');
    const executions = (
      await this.db.query(
        `SELECT e.id,e.worker_id,e.state,e.lease_expires_at,s.id AS session_id,s.node_id,
      s.state AS session_state,s.closure_verified,e.action_count,e.control_mode,e.control_revision,e.control_reason FROM pr_executions e JOIN pr_sessions s ON s.execution_id=e.id WHERE e.task_id=$1`,
        [id],
      )
    ).rows;
    const cleanup = task.definition.caseV2Definition
      ? await this.caseCleanup(id)
      : null;
    return {
      ...task,
      ...summarizeReport(
        task.report,
        task.definition.acceptanceCriteria.map((c) => c.id),
        task.definition,
      ),
      executions,
      ...(task.definition.caseV2Definition
        ? {
            businessCleanup: cleanup
              ? { taskId: cleanup.taskId, status: cleanup.status }
              : null,
          }
        : {}),
    };
  }

  /** worker 真正领取时才预留浏览器，任务等待期间不占用 Chrome。 */
  async claim(workerId: string, structuredSteps = false) {
    const live = this.gateway.live();
    if (!live.length) return { execution: null };
    return this.db.transaction(async (client) => {
      const routes = await routingSnapshot(client);
      const pools = [
        ...new Set(live.map((connection) => connection.heartbeat!.pool)),
      ];
      // 先按资源池选候选，再逐个加锁；一次锁住整批任务会让其他 worker 误判队列为空。
      // 每个在线池都有自己的扫描额度，离线池和拥堵池不能挡住其他池的首批任务。
      const tasks = await client.query<{ id: string }>(
        `SELECT candidate.id FROM unnest($1::text[]) AS pool(name)
        CROSS JOIN LATERAL (SELECT id,created_at FROM pr_tasks WHERE state='QUEUED'
          AND deadline_at>clock_timestamp() AND definition#>>'{environment,nodePool}'=pool.name AND ($3 OR NOT (definition ? 'steps'))
          ORDER BY created_at,id LIMIT $2) candidate ORDER BY candidate.created_at,candidate.id`,
        [pools, BATCH_SIZE, structuredSteps],
      );
      for (const candidate of tasks.rows) {
        const row = (
          await client.query<{
            definition: VerificationTask;
            deadline_at: Date;
          }>(
            "SELECT definition,deadline_at FROM pr_tasks WHERE id=$1 AND state='QUEUED' AND deadline_at>clock_timestamp() FOR UPDATE SKIP LOCKED",
            [candidate.id],
          )
        ).rows[0];
        if (!row) continue;
        const task = row.definition;
        if (task.steps && !structuredSteps) continue;
        const routedNode = resolveRoute(
          routes,
          task.environment.nodePool,
          targetHostname(task.target.url),
        );
        const cleanup = await cleanupPlacement(client, task, routedNode);
        if (cleanup.blocked) {
          await recordQueueReason(client, task.taskId, cleanup.blocked);
          continue;
        }
        if (task.resourceKey) {
          const lock = await client.query(
            'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 2)) AS locked',
            [task.resourceKey],
          );
          if (!lock.rows[0].locked) continue;
          const busy = await client.query(
            `SELECT 1 FROM pr_tasks other WHERE other.definition->>'resourceKey'=$1 AND other.id<>$2 AND (
            other.state='RUNNING'
            OR EXISTS(SELECT 1 FROM pr_executions e JOIN pr_sessions s ON s.execution_id=e.id WHERE e.task_id=other.id AND NOT s.closure_verified)
            OR ($3::text IS NULL AND other.state='QUEUED' AND (other.created_at,other.id)<(SELECT created_at,id FROM pr_tasks WHERE id=$2))
            OR (other.id<>coalesce($3,'') AND EXISTS(SELECT 1 FROM pr_case_cleanups c LEFT JOIN pr_tasks cleanup ON cleanup.id=c.task_id
              WHERE c.parent_task_id=other.id AND c.state<>'SKIPPED'
              AND EXISTS(SELECT 1 FROM pr_executions e WHERE e.task_id=other.id)
              AND (cleanup.id IS NULL OR cleanup.state IN ('QUEUED','RUNNING') OR cleanup.state<>'COMPLETED' OR (cleanup.report->>'executionDisposition') IS DISTINCT FROM 'EXECUTED' OR (cleanup.report->>'verdict') IS DISTINCT FROM 'PASSED')))
          ) LIMIT 1`,
            [task.resourceKey, task.taskId, task.parentTaskId ?? null],
          );
          if (busy.rowCount) {
            await recordQueueReason(client, task.taskId, 'RESOURCE_BUSY');
            continue;
          }
        }
        const placement = await authPlacement(client, task, routedNode);
        if (!placement) continue;
        if (placement.conflict) {
          await recordQueueReason(client, task.taskId, placement.conflict);
          continue;
        }
        const { auth, preferredNode } = placement;
        // 清理归属来自主任务执行记录，不随自动登录偏好、容量或重新配置迁移。
        const requiredNode = cleanup.requiredNode ?? placement.requiredNode;
        // 路由和本轮快照是硬约束；自动槽位只在合格候选中优先，容量不足时可继续选择。
        const candidates = live
          .filter(
            (c) =>
              this.eligible(c.heartbeat!, task) &&
              (!routedNode || c.nodeId === routedNode) &&
              (!requiredNode || c.nodeId === requiredNode),
          )
          .sort(
            (a, b) =>
              Number(b.nodeId === preferredNode) -
                Number(a.nodeId === preferredNode) ||
              a.heartbeat!.occupied.length - b.heartbeat!.occupied.length,
          );
        let queueCode: QueueReason['code'] = 'NO_ELIGIBLE_NODE';
        for (const connection of candidates) {
          const heartbeat = connection.heartbeat!;
          const node = (
            await client.query(
              'SELECT * FROM pr_nodes WHERE id=$1 FOR NO KEY UPDATE',
              [connection.nodeId],
            )
          ).rows[0];
          if (
            !node ||
            node.revoked_at ||
            node.node_epoch !== heartbeat.nodeEpoch ||
            !this.gateway.current(connection)
          )
            continue;
          if (
            (
              await client.query(
                'SELECT 1 FROM pr_pairings WHERE rotate_node_id=$1 AND used_at IS NULL AND expires_at>clock_timestamp()',
                [node.id],
              )
            ).rowCount
          ) {
            if (queueCode !== 'NODE_CAPACITY') queueCode = 'NODE_ROTATING';
            continue;
          }
          const reserved = await client.query(
            'SELECT id FROM pr_sessions WHERE node_id=$1 AND NOT closure_verified',
            [node.id],
          );
          const occupied = new Set([
            ...reserved.rows.map((r) => r.id as string),
            ...heartbeat.occupied.map((s) => s.sessionId),
          ]);
          if (
            occupied.size >=
            Math.min(node.capacity as number, heartbeat.capacity)
          ) {
            queueCode = 'NODE_CAPACITY';
            continue;
          }
          if (auth && !task.environment.auth)
            await client.query(
              'INSERT INTO pr_auth_bindings(scope,node_id) VALUES($1,$2) ON CONFLICT(scope) DO UPDATE SET node_id=EXCLUDED.node_id',
              [auth.stateId, node.id],
            );
          const fence = Number(node.fence) + 1;
          if (fence > MAX_FENCE)
            throw new ApiError(
              503,
              'FENCE_EXHAUSTED',
              'Node fence counter exhausted',
            );
          const executionId = randomUUID();
          const token = newToken();
          const leaseEnd = new Date(
            Math.min(
              row.deadline_at.getTime(),
              Date.now() + this.config.workerLeaseMs,
            ),
          );
          await client.query('UPDATE pr_nodes SET fence=$2 WHERE id=$1', [
            node.id,
            fence,
          ]);
          await client.query(
            "UPDATE pr_tasks SET state='RUNNING',queue_reason=NULL WHERE id=$1",
            [task.taskId],
          );
          await client.query(
            `INSERT INTO pr_executions(id,task_id,worker_id,token_hash,lease_expires_at,state)
            VALUES($1,$2,$3,$4,$5,'STARTING')`,
            [executionId, task.taskId, workerId, digest(token), leaseEnd],
          );
          await client.query(
            `INSERT INTO pr_sessions(id,execution_id,node_id,node_epoch,lease_id,fence,state,last_renew_request,auth_state)
            VALUES($1,$2,$3,$4,$5,$6,'OPENING',$7,$8)`,
            [
              randomUUID(),
              executionId,
              node.id,
              heartbeat.nodeEpoch,
              randomUUID(),
              fence,
              heartbeat.leaseRequestId,
              auth,
            ],
          );
          const context = await executionContext(client, executionId);
          const remaining = Math.max(1, row.deadline_at.getTime() - Date.now());
          await insertCommand(
            client,
            executionId,
            envelope(
              context,
              {
                type: 'session.open',
                ...(task.environment.allowIntervention
                  ? { renewable: true }
                  : {}),
                liveView:
                  task.environment.allowIntervention === true ||
                  !!task.comparison,
                ...(auth ? { authState: auth } : {}),
                networkEvidence: task.acceptanceCriteria.some((c) =>
                  c.evidenceKinds.includes('NETWORK'),
                ),
                leaseRequestId: heartbeat.leaseRequestId,
                leaseTtlMs: this.leaseTtl(context, heartbeat),
                maxDurationMs: Math.min(
                  remaining +
                    (task.cleanupStepIds?.length ? CLEANUP_EXECUTION_MS : 0),
                  heartbeat.limits.maxSessionMs,
                ),
              },
              Math.min(15_000, remaining),
            ),
          );
          return {
            execution: {
              id: executionId,
              task,
              leaseToken: token,
              leaseExpiresAt: leaseEnd,
              taskDeadlineAt: row.deadline_at,
              sessionId: context.session_id,
              nodeId: context.node_id,
              state: 'STARTING',
            },
          };
        }
        await recordQueueReason(client, task.taskId, queueCode);
      }
      return { execution: null };
    });
  }

  /** 能力不足时继续排队；不把缺失能力静默降级成别的证据。 */
  private eligible(heartbeat: Heartbeat, task: VerificationTask): boolean {
    return (
      heartbeat.pool === task.environment.nodePool &&
      (!task.steps ||
        heartbeat.limits.maxSessionMs >=
          task.budget.timeoutMs +
            (task.cleanupStepIds?.length ? CLEANUP_EXECUTION_MS : 0)) &&
      (!(task.environment.allowIntervention || task.comparison) ||
        heartbeat.capabilities.liveView === true) &&
      (!task.environment.allowIntervention ||
        heartbeat.capabilities.renewableSessions === true) &&
      (!sessionAuth(task) || heartbeat.capabilities.authState === true) &&
      (!task.acceptanceCriteria.some((c) =>
        c.evidenceKinds.includes('NETWORK'),
      ) ||
        heartbeat.capabilities.networkEvidence === true) &&
      (!task.acceptanceCriteria.some((c) =>
        c.evidenceKinds.includes('TRACE'),
      ) ||
        heartbeat.capabilities.trace === true) &&
      heartbeat.capabilities.observe &&
      heartbeat.capabilities.writeActions &&
      heartbeat.capabilities.conditionWait &&
      (!task.acceptanceCriteria.some((c) =>
        c.evidenceKinds.includes('SCREENSHOT'),
      ) ||
        heartbeat.capabilities.screenshot)
    );
  }

  /** 节点授权不能超过 worker 的剩余权限；节点自身再扣除心跳传输延迟。 */
  private leaseTtl(context: ExecutionContext, heartbeat: Heartbeat): number {
    return Math.max(
      1,
      Math.min(
        this.config.nodeLeaseMs,
        heartbeat.limits.maxLeaseMs,
        context.lease_expires_at.getTime() - Date.now(),
        executionDeadline(context) - Date.now(),
      ),
    );
  }

  /** 验证执行令牌；读取历史结果可以在租约结束后进行，写操作不能。 */
  private authorize(
    context: ExecutionContext,
    token: string,
    active: boolean,
  ): void {
    if (digest(token) !== context.token_hash)
      throw new ApiError(401, 'UNAUTHORIZED', 'Invalid execution credential');
    if (active) this.active(context);
  }

  /** 人工等待暂停执行时钟，但不能复活失联 worker 的执行权。 */
  private active(context: ExecutionContext): void {
    if (
      context.task_state !== 'RUNNING' ||
      !['STARTING', 'RUNNING'].includes(context.execution_state) ||
      context.lease_expires_at.getTime() <= Date.now() ||
      executionDeadline(context) <= Date.now()
    )
      throw new ApiError(409, 'EXECUTION_EXPIRED', 'Execution lease ended');
  }

  /** 执行 worker 独立续期；节点心跳不能续期一个已经失联的 worker。 */
  async heartbeatExecution(id: string, token: string) {
    return this.db.transaction(async (client) => {
      const context = await executionContext(client, id);
      this.authorize(context, token, true);
      const expires = new Date(
        Math.min(
          executionDeadline(context),
          Date.now() + this.config.workerLeaseMs,
        ),
      );
      await client.query(
        'UPDATE pr_executions SET lease_expires_at=$2 WHERE id=$1',
        [id, expires],
      );
      return {
        leaseExpiresAt: expires,
        taskDeadlineAt: context.deadline_at,
        cleanupDeadlineAt: context.cleanup_deadline_at,
        controlMode: context.control_mode,
        controlRevision: context.control_revision,
      };
    });
  }

  /** worker 查看会话就绪和清理状态；不暴露数据库中的令牌摘要。 */
  async execution(id: string, token: string) {
    return this.db.transaction(async (client) => {
      const context = await executionContext(client, id);
      this.authorize(context, token, false);
      const artifacts = (
        await client.query(
          'SELECT id,kind,hash AS sha256,state FROM pr_artifacts WHERE execution_id=$1 ORDER BY created_at',
          [id],
        )
      ).rows;
      return {
        id,
        taskId: context.task_id,
        state: context.execution_state,
        taskState: context.task_state,
        controlMode: context.control_mode,
        controlRevision: context.control_revision,
        controlReason: context.control_reason,
        actionCount: context.action_count,
        sessionId: context.session_id,
        sessionState: context.session_state,
        closureVerified: context.closure_verified,
        leaseExpiresAt: context.lease_expires_at,
        taskDeadlineAt: context.deadline_at,
        cleanupDeadlineAt: context.cleanup_deadline_at,
        artifacts,
      };
    });
  }

  /** 持久化一次受限浏览器操作；命令 ID 同时承担 HTTP 重试与节点去重。 */
  async command(
    id: string,
    token: string | null,
    commandId: string,
    timeoutMs: number,
    operation: NodeCommand['command'],
    controlRevision = 0,
  ) {
    if (!operation.type.startsWith('browser.'))
      throw new ApiError(
        403,
        'CONTROL_COMMAND_FORBIDDEN',
        'Worker cannot manage node leases or sessions directly',
      );
    const actor = token === null ? 'HUMAN' : 'AGENT';
    if (
      ['browser.auth.save', 'browser.input', 'browser.cookies.set'].includes(
        operation.type,
      ) &&
      token !== null
    )
      throw new ApiError(
        403,
        'CONTROL_COMMAND_FORBIDDEN',
        'Only a human controller can change authentication or send manual input',
      );
    const hash = digest(
      canonical({ timeoutMs, command: operation, actor, controlRevision }),
    );
    return this.db.transaction(async (client) => {
      const context = await executionContext(client, id);
      if (token !== null) this.authorize(context, token, false);
      const existing = (
        await client.query(
          'SELECT execution_id,request_hash,result FROM pr_commands WHERE id=$1',
          [commandId],
        )
      ).rows[0];
      if (existing) {
        if (existing.execution_id !== id || existing.request_hash !== hash)
          throw new ApiError(
            409,
            'COMMAND_CONFLICT',
            'Command identity already binds another request',
          );
        return { commandId, result: existing.result };
      }
      this.active(context);
      if (
        (actor === 'HUMAN' ? 'HUMAN' : 'AUTO') !== context.control_mode ||
        controlRevision !== context.control_revision
      )
        throw new ApiError(
          409,
          'CONTROL_CHANGED',
          'Execution control changed; refresh before acting',
        );
      // Cookie 权限绑定任务 origin，不能借人工链接写入其他站点或任意 URL。
      if (operation.type === 'browser.cookies.set') {
        const url = new URL(operation.url);
        const target = new URL(context.definition.target.url);
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.origin !== target.origin
        )
          throw new ApiError(
            403,
            'COOKIE_ORIGIN_FORBIDDEN',
            'Cookie 只能写入本任务目标站点',
          );
      }
      if (context.session_state !== 'ACTIVE')
        throw new ApiError(
          409,
          'SESSION_NOT_READY',
          'Browser session is not active',
        );
      if (
        (
          await client.query(
            "SELECT 1 FROM pr_commands WHERE session_id=$1 AND kind LIKE 'browser.%' AND result IS NULL",
            [context.session_id],
          )
        ).rowCount
      )
        throw new ApiError(
          409,
          'SESSION_BUSY',
          'One browser operation at a time',
        );
      // 人工操作仍经过权限、代次和串行检查，但不占用或受限于 Agent 动作预算。
      if (actor === 'AGENT' && operation.type === 'browser.act') {
        if (context.action_count >= context.definition.budget.maxActions)
          throw new ApiError(
            409,
            'ACTION_BUDGET_EXCEEDED',
            'Action budget exhausted',
          );
        await client.query(
          'UPDATE pr_executions SET action_count=action_count+1 WHERE id=$1',
          [id],
        );
      }
      const budget = Math.max(
        1,
        Math.min(timeoutMs, executionDeadline(context) - Date.now()),
      );
      await insertCommand(
        client,
        id,
        envelope(context, operation as BrowserOperation, budget, commandId),
        hash,
      );
      await client.query('UPDATE pr_commands SET actor=$2 WHERE id=$1', [
        commandId,
        actor,
      ]);
      return { commandId, result: null };
    });
  }

  /** 结果查询不导致再次派发，执行已停止时仍可读取已提交事实。 */
  async commandResult(id: string, token: string, commandId: string) {
    return this.db.transaction(async (client) => {
      const context = await executionContext(client, id);
      this.authorize(context, token, false);
      const result = (
        await client.query(
          'SELECT id AS "commandId",result FROM pr_commands WHERE id=$1 AND execution_id=$2',
          [commandId, id],
        )
      ).rows[0];
      if (!result)
        throw new ApiError(404, 'COMMAND_MISSING', 'Command not found');
      return result;
    });
  }

  /** 任务取消不会把已发送操作改写成未执行；浏览器清理可以晚于任务终态。 */
  async cancel(id: string) {
    await this.db.transaction(async (client) => {
      const queued = await client.query(
        "UPDATE pr_tasks SET state='CANCELLED',finished_at=clock_timestamp() WHERE id=$1 AND state='QUEUED' RETURNING id",
        [id],
      );
      if (queued.rowCount) return;
      const execution = (
        await client.query('SELECT id FROM pr_executions WHERE task_id=$1', [
          id,
        ])
      ).rows[0];
      if (execution) {
        const context = await executionContext(client, execution.id as string);
        if (context.task_state === 'RUNNING')
          await stopExecution(client, context, 'CANCELLED', 'TASK_CANCELLED');
      }
    });
    return this.task(id);
  }

  /** 完成报告经过证据归属与标准覆盖校验；提交成功后立即撤销新的操作权限。 */
  async complete(
    id: string,
    token: string,
    report: VerificationReport,
    controlRevision = 0,
  ) {
    await this.db.transaction(async (client) => {
      const context = await executionContext(client, id);
      this.authorize(context, token, false);
      // 截止时间已经过去时，报告不能抢在定时扫描前将任务记录为正常完成。
      if (
        context.task_state === 'RUNNING' &&
        executionDeadline(context) <= Date.now()
      ) {
        await stopExecution(
          client,
          context,
          'TIMED_OUT',
          context.cleanup_deadline_at
            ? 'CLEANUP_DEADLINE_EXCEEDED'
            : 'TASK_DEADLINE',
        );
        context.task_state = 'TIMED_OUT';
      }
      const stored = (
        await client.query('SELECT report FROM pr_tasks WHERE id=$1', [
          context.task_id,
        ])
      ).rows[0].report;
      const verified = await this.artifacts.validateReport(
        client,
        context,
        report,
      );
      // 完成回执可能丢失，所有终态都按相同报告确认，禁止改写既有结论。
      if (stored) {
        if (canonical(verified) !== canonical(stored))
          throw new ApiError(
            409,
            'REPORT_CONFLICT',
            'Completed report is immutable',
          );
        return;
      }
      const active = context.task_state === 'RUNNING';
      if (
        !active &&
        (!['ERROR', 'CANCELLED', 'TIMED_OUT'].includes(context.task_state) ||
          report.executionDisposition !== 'ERROR')
      )
        throw new ApiError(
          409,
          'EXECUTION_ENDED',
          'Only error metadata may be attached after termination',
        );
      if (active) {
        if (
          report.executionDisposition !== 'ERROR' &&
          (context.control_mode !== 'AUTO' ||
            context.control_revision !== controlRevision)
        )
          throw new ApiError(
            409,
            'CONTROL_CHANGED',
            'Refresh after human intervention before reporting',
          );
        // 故障报告只撤权和关闭，不赋予任何新操作；失效租约仍可提交停止原因。
        if (report.executionDisposition !== 'ERROR')
          this.authorize(context, token, true);
        if (
          report.executionDisposition !== 'ERROR' &&
          (
            await client.query(
              "SELECT 1 FROM pr_commands WHERE execution_id=$1 AND kind LIKE 'browser.%' AND result IS NULL",
              [id],
            )
          ).rowCount
        )
          throw new ApiError(
            409,
            'COMMAND_PENDING',
            'Finish pending browser operations first',
          );
      }
      await client.query('UPDATE pr_tasks SET report=$2 WHERE id=$1', [
        context.task_id,
        verified,
      ]);
      if (active)
        await stopExecution(
          client,
          context,
          report.executionDisposition === 'ERROR' ? 'ERROR' : 'COMPLETED',
          report.executionDisposition === 'ERROR'
            ? 'AGENT_ERROR'
            : report.executionDisposition === 'BLOCKED'
              ? 'VERIFICATION_BLOCKED'
              : 'EXECUTION_COMPLETED',
        );
    });
    return this.execution(id, token);
  }

  /** 撤销机器凭据并停止关联执行；断开连接并不释放该节点的占用。 */
  async revokeNode(id: string): Promise<void> {
    await this.db.transaction(async (client) => {
      const node = await client.query(
        'UPDATE pr_nodes SET revoked_at=clock_timestamp() WHERE id=$1 RETURNING id',
        [id],
      );
      if (!node.rowCount)
        throw new ApiError(404, 'NODE_MISSING', 'Node not found');
      const executions = await client.query(
        'SELECT execution_id FROM pr_sessions WHERE node_id=$1 AND NOT closure_verified',
        [id],
      );
      for (const row of executions.rows)
        await stopExecution(
          client,
          await executionContext(client, row.execution_id as string),
          'ERROR',
          'NODE_REVOKED',
        );
    });
    this.gateway.disconnect(id);
  }

  /** 节点事件在一个事务中去重、更新事实；调用方只能在此方法成功后 ACK。 */
  async receive(connection: Connection, event: NodeEvent): Promise<void> {
    await this.db.transaction(async (client) => {
      // 节点主键不变，使用 NO KEY UPDATE 保持事件串行，同时允许命令外键取得 KEY SHARE。
      // 否则心跳等待 execution 行、命令等待 node 外键时会形成死锁并浪费租约窗口。
      const node = (
        await client.query(
          'SELECT * FROM pr_nodes WHERE id=$1 FOR NO KEY UPDATE',
          [connection.nodeId],
        )
      ).rows[0];
      if (
        !this.gateway.current(connection) ||
        !node ||
        node.revoked_at ||
        node.credential_hash !== connection.credentialHash
      )
        throw new ApiError(
          401,
          'STALE_CONNECTION',
          'Node connection no longer authorized',
        );
      if (event.type === 'node.heartbeat') {
        await this.nodeHeartbeat(
          client,
          connection,
          event,
          node.node_epoch as string | null,
          node.pool as string,
        );
        return;
      }
      if (!connection.heartbeat)
        throw new ApiError(
          400,
          'HEARTBEAT_REQUIRED',
          'First frame must identify the node incarnation',
        );
      if (event.type === 'protocol.error' || event.type === 'command.pending')
        return;
      const hash = digest(canonical(event));
      const prior = (
        await client.query(
          'SELECT payload_hash FROM pr_node_inbox WHERE node_id=$1 AND message_id=$2',
          [connection.nodeId, event.messageId],
        )
      ).rows[0];
      if (prior) {
        if (prior.payload_hash !== hash)
          throw new ApiError(
            409,
            'MESSAGE_CONFLICT',
            'Message identity changed payload',
          );
        return;
      }
      if (event.type === 'command.result')
        await this.commandEvent(client, connection.nodeId, event);
      else if (event.type === 'artifact.available')
        await this.artifacts.available(
          client,
          connection.nodeId,
          event.artifactId,
          event.sha256,
        );
      else await this.closureEvent(client, connection.nodeId, event);
      await client.query(
        'INSERT INTO pr_node_inbox(node_id,message_id,payload_hash,payload) VALUES($1,$2,$3,$4)',
        [connection.nodeId, event.messageId, hash, event],
      );
    });
  }

  /** 新启动身份触发旧执行终止；旧关闭事件仍可归还其原有资源。 */
  private async nodeHeartbeat(
    client: PoolClient,
    connection: Connection,
    heartbeat: Heartbeat,
    oldEpoch: string | null,
    pool: string,
  ): Promise<void> {
    if (
      heartbeat.nodeId !== connection.nodeId ||
      heartbeat.pool !== pool ||
      heartbeat.capacity < 1 ||
      heartbeat.capacity > 32
    )
      throw new ApiError(
        400,
        'NODE_IDENTITY_MISMATCH',
        'Heartbeat differs from registration',
      );
    if (oldEpoch && oldEpoch !== heartbeat.nodeEpoch) {
      const sessions = await client.query(
        'SELECT execution_id FROM pr_sessions WHERE node_id=$1 AND NOT closure_verified AND node_epoch<>$2',
        [connection.nodeId, heartbeat.nodeEpoch],
      );
      for (const row of sessions.rows)
        await stopExecution(
          client,
          await executionContext(client, row.execution_id as string),
          'ERROR',
          'NODE_RESTARTED',
        );
    }
    await client.query(
      'UPDATE pr_nodes SET node_epoch=$2,capacity=$3,capabilities=$4,inventory=$5,last_seen_at=clock_timestamp() WHERE id=$1',
      [
        connection.nodeId,
        heartbeat.nodeEpoch,
        heartbeat.capacity,
        heartbeat.capabilities,
        JSON.stringify(heartbeat.occupied),
      ],
    );
    const sessions = await client.query(
      "SELECT execution_id,last_renew_request FROM pr_sessions WHERE node_id=$1 AND node_epoch=$2 AND state='ACTIVE'",
      [connection.nodeId, heartbeat.nodeEpoch],
    );
    for (const row of sessions.rows) {
      if (row.last_renew_request === heartbeat.leaseRequestId) continue;
      const context = await executionContext(
        client,
        row.execution_id as string,
      );
      if (
        context.task_state !== 'RUNNING' ||
        context.execution_state !== 'RUNNING' ||
        context.lease_expires_at.getTime() <= Date.now() ||
        executionDeadline(context) <= Date.now()
      )
        continue;
      await insertCommand(
        client,
        context.id,
        envelope(
          context,
          {
            type: 'session.renew',
            leaseRequestId: heartbeat.leaseRequestId,
            leaseTtlMs: this.leaseTtl(context, heartbeat),
          },
          5000,
        ),
      );
      await client.query(
        'UPDATE pr_sessions SET last_renew_request=$2 WHERE id=$1',
        [context.session_id, heartbeat.leaseRequestId],
      );
    }
  }

  /** 结果只能作用于原命令所属的执行；迟到结果归档，但不覆盖已确定的终态。 */
  private async commandEvent(
    client: PoolClient,
    nodeId: string,
    event: CommandResult,
  ): Promise<void> {
    const row = (
      await client.query(
        'SELECT * FROM pr_commands WHERE id=$1 AND node_id=$2',
        [event.commandId, nodeId],
      )
    ).rows[0];
    if (!row)
      throw new ApiError(
        409,
        'COMMAND_MISSING',
        'Result has no durable command',
      );
    const request = row.envelope as NodeCommand;
    if (
      event.messageId !== event.commandId ||
      event.nodeId !== nodeId ||
      event.sessionId !== request.sessionId ||
      event.nodeEpoch !== request.nodeEpoch ||
      event.leaseId !== request.leaseId ||
      event.fence !== request.fence
    )
      throw new ApiError(
        409,
        'RESULT_IDENTITY_MISMATCH',
        'Result belongs to another session or lease',
      );
    const context = await executionContext(client, row.execution_id as string);
    const result = await this.artifacts.register(
      client,
      context,
      event,
      row.kind === 'browser.observe',
    );
    await client.query(
      'UPDATE pr_commands SET result=$2 WHERE id=$1 AND result IS NULL',
      [event.commandId, result],
    );
    if (
      row.kind === 'session.open' &&
      event.operationStatus !== 'SUCCEEDED' &&
      event.effect === 'NOT_STARTED'
    ) {
      if (context.task_state === 'RUNNING')
        await stopExecution(
          client,
          context,
          'ERROR',
          event.error?.code ?? 'OPEN_FAILED',
        );
      await releaseSession(client, context);
    } else if (
      row.kind === 'session.close' &&
      event.operationStatus === 'SUCCEEDED' &&
      event.data?.state === 'CLOSED'
    ) {
      await releaseSession(client, context);
    } else if (!row.result && context.task_state === 'RUNNING') {
      if (
        row.kind === 'session.open' &&
        event.operationStatus === 'SUCCEEDED'
      ) {
        await client.query(
          "UPDATE pr_sessions SET state='ACTIVE' WHERE id=$1 AND state='OPENING'",
          [context.session_id],
        );
        await client.query(
          "UPDATE pr_executions SET state='RUNNING' WHERE id=$1 AND state='STARTING'",
          [context.id],
        );
      } else if (
        event.effect === 'MAY_HAVE_HAPPENED' ||
        (['session.open', 'session.renew'].includes(row.kind as string) &&
          event.operationStatus !== 'SUCCEEDED')
      ) {
        await stopExecution(
          client,
          context,
          'ERROR',
          event.error?.code ?? 'OPERATION_UNKNOWN',
        );
      }
    }
  }

  /** 恢复重送可携带旧 nodeEpoch，只能关闭其完全匹配的旧会话，不能推进新执行。 */
  private async closureEvent(
    client: PoolClient,
    nodeId: string,
    event: Extract<NodeEvent, { type: 'session.closed' }>,
  ): Promise<void> {
    const session = (
      await client.query(
        'SELECT execution_id FROM pr_sessions WHERE id=$1 AND node_id=$2',
        [event.sessionId, nodeId],
      )
    ).rows[0];
    if (!session)
      throw new ApiError(
        409,
        'SESSION_MISSING',
        'Closure has no registered session',
      );
    const context = await executionContext(
      client,
      session.execution_id as string,
    );
    if (
      event.nodeEpoch !== context.node_epoch ||
      event.leaseId !== context.lease_id ||
      event.fence !== Number(context.fence) ||
      event.closureVerified !== (event.state === 'CLOSED')
    )
      throw new ApiError(
        409,
        'CLOSURE_MISMATCH',
        'Closure identity or state mismatch',
      );
    if (context.closure_verified) return;
    if (context.task_state === 'RUNNING')
      await stopExecution(client, context, 'ERROR', 'SESSION_ENDED');
    if (event.closureVerified) await releaseSession(client, context);
    else
      await client.query(
        "UPDATE pr_sessions SET state='QUARANTINED' WHERE id=$1",
        [context.session_id],
      );
  }

  /** 到期、清理和投递使用同一个有界循环；调用方保证不会重入。 */
  async tick(): Promise<void> {
    await this.scheduleCaseCleanups();
    if (!this.db.healthy)
      throw new ApiError(
        503,
        'DATABASE_UNAVAILABLE',
        'Database ownership unavailable',
      );
    await this.expire();
    await this.deliver();
  }

  /** 到期撤权与浏览器关闭分别记录；不自动重试整个验证任务。 */
  private async expire(): Promise<void> {
    await this.db.query(
      "UPDATE pr_tasks SET state='TIMED_OUT',finished_at=clock_timestamp(),error=jsonb_build_object('code','TASK_QUEUE_TIMEOUT','message','任务在排队阶段超过总预算。','queueReason',queue_reason) WHERE state='QUEUED' AND deadline_at<=clock_timestamp()",
    );
    const expired = await this.db.query(
      `SELECT e.id FROM pr_executions e JOIN pr_tasks t ON t.id=e.task_id
      WHERE e.state IN ('STARTING','RUNNING') AND (e.lease_expires_at<=clock_timestamp() OR t.cleanup_deadline_at<=clock_timestamp() OR (e.control_mode='AUTO' AND t.deadline_at<=clock_timestamp())) LIMIT $1`,
      [BATCH_SIZE],
    );
    for (const row of expired.rows)
      await this.db.transaction(async (client) => {
        const context = await executionContext(client, row.id as string);
        if (!['STARTING', 'RUNNING'].includes(context.execution_state)) return;
        if (executionDeadline(context) <= Date.now())
          await stopExecution(
            client,
            context,
            'TIMED_OUT',
            context.cleanup_deadline_at
              ? 'CLEANUP_DEADLINE_EXCEEDED'
              : 'TASK_DEADLINE_EXCEEDED',
          );
        else if (context.lease_expires_at.getTime() <= Date.now())
          await stopExecution(client, context, 'ERROR', 'WORKER_LEASE_EXPIRED');
      });
    const commands = await this.db.query(
      'SELECT id,execution_id FROM pr_commands WHERE result IS NULL AND deadline_at<=clock_timestamp() LIMIT $1',
      [BATCH_SIZE],
    );
    for (const row of commands.rows)
      await this.db.transaction(async (client) => {
        const context = await executionContext(
          client,
          row.execution_id as string,
        );
        const command = (
          await client.query(
            'SELECT * FROM pr_commands WHERE id=$1 AND result IS NULL FOR UPDATE',
            [row.id],
          )
        ).rows[0];
        if (!command) return;
        await client.query('UPDATE pr_commands SET result=$2 WHERE id=$1', [
          command.id,
          syntheticResult(
            command.envelope,
            Boolean(command.first_sent_at),
            'DEADLINE_EXCEEDED',
          ),
        ]);
        if (
          command.kind !== 'session.close' &&
          context.task_state === 'RUNNING' &&
          (command.first_sent_at || command.kind === 'session.open')
        )
          await stopExecution(
            client,
            context,
            'ERROR',
            'COMMAND_DEADLINE_EXCEEDED',
          );
      });
    const cleanup = await this.db.query(
      `SELECT s.execution_id FROM pr_sessions s WHERE s.state='CLOSING' AND NOT s.closure_verified
      AND NOT EXISTS(SELECT 1 FROM pr_commands c WHERE c.session_id=s.id AND c.kind='session.close'
        AND (c.result IS NULL OR c.created_at>clock_timestamp()-$1*interval '1 millisecond')) LIMIT $2`,
      [CLEANUP_RETRY_MS, BATCH_SIZE],
    );
    for (const row of cleanup.rows)
      await this.db.transaction(async (client) => {
        const context = await executionContext(
          client,
          row.execution_id as string,
        );
        if (context.session_state === 'CLOSING')
          await stopExecution(client, context, 'ERROR', 'CLEANUP_PENDING');
      });
  }

  /** 先记录投递尝试再发送；网络失败只能重送原始信封。 */
  private async deliver(): Promise<void> {
    const liveIds = this.gateway.live().map((connection) => connection.nodeId);
    if (!liveIds.length) return;
    // 离线和旧进程身份的命令仍保留在数据库，但不挤占在线节点的投递批次。
    const rows = await this.db.query(
      `SELECT c.id,c.execution_id FROM pr_commands c JOIN pr_nodes n ON n.id=c.node_id
      WHERE c.result IS NULL AND c.deadline_at>clock_timestamp() AND c.next_delivery_at<=clock_timestamp()
        AND c.node_id=ANY($1::text[]) AND c.envelope->>'nodeEpoch'=n.node_epoch
      ORDER BY CASE c.kind WHEN 'session.close' THEN 0 WHEN 'session.renew' THEN 1 ELSE 2 END,c.created_at LIMIT $2`,
      [liveIds, BATCH_SIZE],
    );
    for (const row of rows.rows) {
      const command = await this.db.transaction(async (client) => {
        const context = await executionContext(
          client,
          row.execution_id as string,
        );
        const current = (
          await client.query(
            'SELECT envelope,result,deadline_at FROM pr_commands WHERE id=$1 FOR UPDATE',
            [row.id],
          )
        ).rows[0];
        if (
          !current ||
          current.result ||
          current.deadline_at <= new Date() ||
          context.closure_verified
        )
          return null;
        const envelope = current.envelope as NodeCommand;
        if (
          envelope.command.type !== 'session.close' &&
          (context.task_state !== 'RUNNING' ||
            context.lease_expires_at.getTime() <= Date.now())
        )
          return null;
        if (
          !this.gateway
            .live()
            .some(
              (c) =>
                c.nodeId === envelope.nodeId &&
                c.heartbeat?.nodeEpoch === envelope.nodeEpoch,
            )
        )
          return null;
        await client.query(
          `UPDATE pr_commands SET first_sent_at=COALESCE(first_sent_at,clock_timestamp()),next_delivery_at=clock_timestamp()+$2*interval '1 millisecond' WHERE id=$1`,
          [row.id, DELIVERY_INTERVAL_MS],
        );
        return envelope;
      });
      if (command) await this.gateway.send(command);
    }
  }
}
