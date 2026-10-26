import { supportsCapabilities } from '@proofrun/contracts';
import { recoverableFocusFailure } from '@proofrun/contracts';
import { assertSupportedSession, usesLocalIdentity } from '../sessions/plan.js';
import { TaskReader } from '../tasks/reader.js';
import {
  ExternalAccounts,
  ACCOUNT_CLOSE_MARGIN_MS,
} from '../account-providers/service.js';
import {
  registerRequest,
  registerMembers,
  type RequestRegistration,
} from '../requests/registration.js';
import { staleRenewal } from './renewal.js';
import { taskEvidenceKinds } from '@proofrun/contracts';
import { authorizeCookieCleanup } from './cookie-cleanup.js';
import { sessionBudgetMs } from '@proofrun/contracts';
import { startStepBudget, consumeStepBudget } from './step-budget.js';
import {
  executionDeadline,
  executionTimeoutCode,
  CLEANUP_EXECUTION_MS,
} from './execution-time.js';
import { recoverableObservationFailure } from '@proofrun/contracts';
import { randomUUID } from 'node:crypto';
import {
  validateVerificationTask,
  validateStepResults,
  type StepResult,
} from '@proofrun/contracts';
import { assertCaseExecution, CASE_TASK_ID } from '../cases/structured.js';
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
import { identityPlacement, recordQueueReason } from './placement.js';
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
  /** 人工直连事件与节点 inbox 在同一事务处理。 */
  humanEvent!: (
    client: PoolClient,
    nodeId: string,
    event: Extract<NodeEvent, { type: 'hitl.result' | 'hitl.finished' }>,
  ) => Promise<void>;
  /** 外部申请异步执行，不阻塞节点租约投递。 */
  readonly externalAccounts: ExternalAccounts;
  constructor(
    private readonly db: Database,
    private readonly config: ApiConfig,
    private readonly artifacts: ArtifactStore,
    /** 读模型由应用装配共享，调度器只在写入后读取响应。 */
    private readonly reader: TaskReader,
  ) {
    this.externalAccounts = new ExternalAccounts(db, config.devPass);
  }

  /** 接收上层定义的任务快照；相同身份只允许相同定义。 */
  async submit(task: VerificationTask) {
    assertSupportedSession(task.sessionPlan);
    if (task.resourceKey !== undefined)
      throw new ApiError(
        422,
        'RESOURCE_LOCK_RETIRED',
        '资源锁已停用，请移除 resourceKey 并明确安排业务依赖',
      );
    if (task.executionMode && task.executionMode !== 'llm')
      throw new ApiError(422, 'EXECUTION_MODE_RETIRED', '新任务只支持 llm');
    if (
      task.sessionPlan?.mode === 'external' ||
      !!task.sessionPlan?.external ||
      task.steps ||
      task.profilePlan ||
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
        '双跑模式已停用，请移除 comparison 并使用 LLM 创建新任务',
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
          (kind) =>
            !['DOM', 'SCREENSHOT', 'NETWORK', 'TRACE', 'RUNTIME'].includes(
              kind,
            ),
        ),
      )
    )
      throw new ApiError(
        422,
        'UNSUPPORTED_EVIDENCE',
        'This release supports DOM, SCREENSHOT, NETWORK and TRACE evidence',
      );
    await this.enqueue([task], task.taskId);
    return this.reader.task(task.taskId);
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
          'SELECT definition_hash,deleted_at FROM pr_tasks WHERE id=$1',
          [task.taskId],
        );
        if (existing.rows[0]?.deleted_at)
          throw new ApiError(409, 'TASK_DELETED', '该运行已删除，不能重新提交');
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
  async submitCaseBatch(
    tasks: VerificationTask[],
    request?: RequestRegistration,
  ) {
    await this.db.transaction(async (client) => {
      if (request && !(await registerRequest(client, request))) return;
      const created = new Set<string>();
      for (const task of [...tasks].sort((a, b) =>
        a.taskId.localeCompare(b.taskId),
      )) {
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [task.taskId],
        );
      }
      for (const task of tasks) {
        assertSupportedSession(task.sessionPlan);
        if (
          !validateVerificationTask(task) ||
          !task.caseV2Definition ||
          task.budget.timeoutMs > MAX_TASK_MS ||
          task.budget.maxActions > 10000
        )
          throw new ApiError(422, 'INVALID_CASE', '任务定义或预算无效');
        const existing = (
          await client.query(
            'SELECT definition,deleted_at FROM pr_tasks WHERE id=$1 FOR UPDATE',
            [task.taskId],
          )
        ).rows[0];
        if (existing) {
          if (existing.deleted_at)
            throw new ApiError(
              409,
              'TASK_DELETED',
              '该运行已删除，不能重新提交',
            );
          if (request?.sourceRequestId)
            throw new ApiError(
              409,
              'CASE_CONFLICT',
              '请求重跑的目标 runId 已存在',
            );
          if (
            canonical(existing.definition.caseV2Definition) !==
              canonical(task.caseV2Definition) ||
            canonical(existing.definition.rerunSession ?? null) !==
              canonical(task.rerunSession ?? null)
          )
            throw new ApiError(409, 'CASE_CONFLICT', 'caseId 已绑定另一份定义');
          continue;
        }
        this.externalAccounts.prepare(task);
        this.externalAccounts.validate(task);
        created.add(task.taskId);
        assertCaseExecution(task);
        await client.query(
          `INSERT INTO pr_tasks(id,definition,definition_hash,state,deadline_at)
          VALUES($1,$2,$3,'QUEUED',clock_timestamp()+$4*interval '1 millisecond')`,
          [task.taskId, task, digest(canonical(task)), task.budget.timeoutMs],
        );
      }
      if (request) await registerMembers(client, request, tasks, created);
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
      await startStepBudget(client, context, input);
      await client.query('UPDATE pr_tasks SET step_results=$2 WHERE id=$1', [
        context.task_id,
        JSON.stringify(input),
      ]);
      return {
        saved: true,
        taskDeadlineAt: context.deadline_at,
        cleanupDeadlineAt: context.cleanup_deadline_at,
        stepBudget: context.budget_state,
        stepBudgets: context.budget_state?.steps,
        leaseExpiresAt: context.lease_expires_at,
        controlMode: await confirmedControlMode(client, context),
        controlRevision: context.control_revision,
      };
    });
  }

  /** 内部重跑创建独立 LLM 任务；结构化 Case 必须使用 v2 重跑入口。 */
  async rerun(sourceId: string, runId: string) {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(runId) || runId === sourceId)
      throw new ApiError(400, 'INVALID_RERUN', '重跑需要一个新的有效任务身份');
    const source = await this.reader.task(sourceId);
    const definition = source.definition as VerificationTask;
    if (definition.steps)
      throw new ApiError(
        400,
        'CASE_ENDPOINT_REQUIRED',
        '结构化任务请通过 /v2/cases/:id/rerun 新增运行，不支持在内部入口重跑',
      );
    const { comparison: _comparison, ...business } = definition;
    await this.submit({ ...business, taskId: runId, executionMode: 'llm' });
    return { taskId: runId };
  }

  /** 旧双跑写入入口明确拒绝，不再创建任务。 */
  async compare(
    _sourceId: string,
    _comparisonId: string,
    _maxActions?: number,
  ) {
    throw new ApiError(
      410,
      'EXECUTION_MODE_RETIRED',
      '双跑入口已停用，请创建 LLM 运行',
    );
  }

  /** worker 真正领取时才预留浏览器，任务等待期间不占用 Chrome。 */
  async claim(
    workerId: string,
    structuredSteps = false,
    stepBudgetVersion?: number,
    identityVersion?: number,
    profileTabsVersion?: number,
    executionPlanVersion?: number,
  ) {
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
          AND deadline_at>clock_timestamp() AND definition#>>'{environment,nodePool}'=pool.name AND ($3 OR NOT (definition ? 'steps')) AND ($4 OR NOT (definition ? 'stepBudget')) AND ($5 OR NOT (definition ? 'sessionPlan')) AND ($6 OR NOT (definition ? 'profilePlan')) AND ($7 OR NOT (definition ? 'executionPlan'))
          ORDER BY created_at,id LIMIT $2) candidate ORDER BY candidate.created_at,candidate.id`,
        [
          pools,
          BATCH_SIZE,
          structuredSteps,
          stepBudgetVersion === 1,
          identityVersion === 1 || identityVersion === 2,
          profileTabsVersion === 1,
          executionPlanVersion === 1,
        ],
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
        if (usesLocalIdentity(task.sessionPlan)) {
          await recordQueueReason(client, task.taskId, 'IDENTITY_UNAVAILABLE');
          continue;
        }
        if (
          task.purpose === 'cleanup' ||
          task.comparison ||
          (task.executionMode && task.executionMode !== 'llm')
        )
          continue;
        if (task.executionPlan && executionPlanVersion !== 1) continue;
        if (task.steps && !structuredSteps) continue;
        if (task.stepBudget && stepBudgetVersion !== 1) continue;
        const routedNode = resolveRoute(
          routes,
          task.environment.nodePool,
          targetHostname(task.target.url),
        );
        if (task.sessionPlan && identityVersion !== 1 && identityVersion !== 2)
          continue;
        if (task.profilePlan && profileTabsVersion !== 1) continue;
        const placement = identityPlacement(task, routedNode);
        if (placement.conflict) {
          await recordQueueReason(client, task.taskId, placement.conflict);
          continue;
        }
        const requiredNode = placement.requiredNode;
        // 路由和显式身份节点是硬约束，合格节点按当前占用排序。
        const candidates = live
          .filter(
            (c) =>
              this.eligible(c.heartbeat!, task) &&
              (!routedNode || c.nodeId === routedNode) &&
              (!requiredNode || c.nodeId === requiredNode),
          )
          .sort(
            (a, b) =>
              a.heartbeat!.occupied.length - b.heartbeat!.occupied.length,
          );
        let queueCode: QueueReason['code'] = 'NO_ELIGIBLE_NODE';
        const routed = live.filter(
          (c) =>
            c.heartbeat!.pool === task.environment.nodePool &&
            (!routedNode || c.nodeId === routedNode) &&
            (!requiredNode || c.nodeId === requiredNode),
        );
        if (
          !candidates.length &&
          task.steps &&
          routed.length &&
          routed.every(
            (c) => c.heartbeat!.limits.maxSessionMs < sessionBudgetMs(task),
          )
        )
          queueCode = 'SESSION_BUDGET_UNSUPPORTED';
        if (
          !candidates.length &&
          routed.some((c) => c.heartbeat?.admission?.accepting === false)
        )
          queueCode = 'NODE_CAPACITY';
        if (
          routed.length &&
          routed.every(
            (c) =>
              !supportsCapabilities(
                c.heartbeat!.capabilities,
                task.executionPlan?.requiredCapabilities ?? [],
              ),
          )
        ) {
          await client.query(
            "UPDATE pr_tasks SET state='ERROR',finished_at=clock_timestamp(),queue_reason=NULL,error=$2 WHERE id=$1 AND state='QUEUED'",
            [
              task.taskId,
              {
                code: 'CAPABILITY_UNSUPPORTED',
                message: '在线路由节点不支持本用例需要的取证能力',
                requiredCapabilities: task.executionPlan?.requiredCapabilities,
              },
            ],
          );
          continue;
        }
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
            (node.admission_retry_at && node.admission_retry_at > new Date()) ||
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
            queueCode = 'NODE_ROTATING';
            continue;
          }
          // 心跳只是候选提示；同一节点启动握手串行，最终准入由节点资源快照决定。
          if (
            (
              await client.query(
                "SELECT 1 FROM pr_sessions WHERE node_id=$1 AND state='OPENING'",
                [node.id],
              )
            ).rowCount
          )
            continue;
          const external = task.sessionPlan?.external
            ? await this.externalAccounts.reserve(
                client,
                task,
                node.id as string,
              )
            : null;
          if (task.sessionPlan?.external && !external) {
            queueCode = 'EXTERNAL_ACCOUNT_WAIT';
            break;
          }
          const fence = Number(node.fence) + 1;
          if (fence > MAX_FENCE)
            throw new ApiError(
              503,
              'FENCE_EXHAUSTED',
              'Node fence counter exhausted',
            );
          await client.query(
            'UPDATE pr_tasks SET queue_deadline_at=COALESCE(queue_deadline_at,deadline_at) WHERE id=$1',
            [task.taskId],
          );
          const executionId = randomUUID();
          const token = newToken();
          // 排队时间不侵占新版逐步额度；领取后才启用自动执行的总安全期限。
          if (task.stepBudget) {
            row.deadline_at = new Date(
              Date.now() +
                task.budget.timeoutMs +
                task.stepBudget.settleMs * task.stepBudget.steps.length +
                (task.sessionPlan?.external
                  ? task.sessionPlan.preparationMs
                  : 0),
            );
            await client.query(
              'UPDATE pr_tasks SET deadline_at=$2 WHERE id=$1',
              [task.taskId, row.deadline_at],
            );
          }
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
            `INSERT INTO pr_sessions(id,execution_id,node_id,node_epoch,lease_id,fence,state,last_renew_request,auth_state,node_runtime)
            VALUES($1,$2,$3,$4,$5,$6,'OPENING',$7,$8,$9)`,
            [
              randomUUID(),
              executionId,
              node.id,
              heartbeat.nodeEpoch,
              randomUUID(),
              fence,
              heartbeat.leaseRequestId,
              null,
              // 冻结分配时的进程版本，后续升级或回退不改写该执行的诊断事实。
              heartbeat.runtime ?? null,
            ],
          );
          const context = await executionContext(client, executionId);
          if (external) {
            await this.externalAccounts.bind(
              client,
              task.taskId,
              context.session_id,
            );
            context.external_expires_at = new Date(
              external.expires_at!.getTime() - ACCOUNT_CLOSE_MARGIN_MS,
            );
            await client.query(
              'UPDATE pr_sessions SET external_expires_at=$2 WHERE id=$1',
              [context.session_id, context.external_expires_at],
            );
          }
          const remaining = Math.max(1, row.deadline_at.getTime() - Date.now());
          await insertCommand(
            client,
            executionId,
            envelope(
              context,
              {
                type: 'session.open',
                ...(heartbeat.capabilities.reducedMotion === true
                  ? { reducedMotion: task.sessionPlan?.reducedMotion ?? true }
                  : {}),
                ...(external
                  ? {
                      externalAccount: {
                        leaseId: external.lease_id!,
                        materialVersion: external.material_version!,
                        origin: task.sessionPlan!.external!.origin,
                        ttlMs: Math.max(
                          1,
                          external.expires_at!.getTime() -
                            Date.now() -
                            ACCOUNT_CLOSE_MARGIN_MS,
                        ),
                      },
                    }
                  : {}),
                ...(task.environment.allowIntervention
                  ? { renewable: true }
                  : {}),
                liveView: heartbeat.capabilities.directHitl === true,
                networkEvidence: taskEvidenceKinds(task).some((kind) =>
                  ['NETWORK', 'RUNTIME'].includes(kind),
                ),
                leaseRequestId: heartbeat.leaseRequestId,
                leaseTtlMs: this.leaseTtl(context, heartbeat),
                maxDurationMs: Math.min(
                  remaining +
                    (task.cleanupStepIds?.length ? CLEANUP_EXECUTION_MS : 0),
                  heartbeat.limits.maxSessionMs,
                ),
              },
              Math.min(external ? 120_000 : 15_000, remaining),
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

  /** 候选节点必须满足所需能力；确定的版本缺口由准入层单独报告。 */
  private eligible(heartbeat: Heartbeat, task: VerificationTask): boolean {
    return (
      supportsCapabilities(
        heartbeat.capabilities,
        task.executionPlan?.requiredCapabilities ?? [],
      ) &&
      (!taskEvidenceKinds(task).includes('RUNTIME') ||
        heartbeat.capabilities.runtimeEvidenceVersion === 1) &&
      heartbeat.pool === task.environment.nodePool &&
      heartbeat.admission?.accepting === true &&
      (!task.sessionPlan?.external ||
        heartbeat.capabilities.externalAccounts === true) &&
      heartbeat.capabilities.ephemeralProfiles === true &&
      (task.sessionPlan?.reducedMotion === undefined ||
        heartbeat.capabilities.reducedMotion === true) &&
      (!task.executionPlan ||
        heartbeat.capabilities.environmentProof === true) &&
      (!task.profilePlan || heartbeat.capabilities.profileTabs === true) &&
      (!task.steps || heartbeat.limits.maxSessionMs >= sessionBudgetMs(task)) &&
      (!task.environment.allowIntervention ||
        heartbeat.capabilities.liveView === true) &&
      (!task.environment.allowIntervention ||
        (heartbeat.capabilities.renewableSessions === true &&
          heartbeat.capabilities.directHitl === true &&
          !!heartbeat.publicUrl)) &&
      (!taskEvidenceKinds(task).some((kind) =>
        ['NETWORK', 'RUNTIME'].includes(kind),
      ) ||
        heartbeat.capabilities.networkEvidence === true) &&
      (!taskEvidenceKinds(task).includes('TRACE') ||
        heartbeat.capabilities.trace === true) &&
      heartbeat.capabilities.observe &&
      heartbeat.capabilities.writeActions &&
      heartbeat.capabilities.conditionWait &&
      (!taskEvidenceKinds(task).includes('SCREENSHOT') ||
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
      const context = await executionContext(client, id, {});
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
        stepBudget: context.budget_state,
        stepBudgets: context.budget_state?.steps,
        controlMode: await confirmedControlMode(client, context),
        controlRevision: context.control_revision,
      };
    });
  }

  /** worker 查看会话就绪和清理状态；不暴露数据库中的令牌摘要。 */
  async execution(id: string, token: string) {
    return this.db.transaction(async (client) => {
      // 多次读取共享同一快照，但不取得写锁；真正的命令准入仍重新核验当前授权。
      await client.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      const context = await executionContext(client, id, {
        lock: false,
      });
      this.authorize(context, token, false);
      const artifacts = (
        await client.query(
          'SELECT id,kind,hash AS sha256,state FROM pr_artifacts WHERE execution_id=$1 ORDER BY created_at',
          [id],
        )
      ).rows;
      const confirmation = (
        await client.query(
          'SELECT confirmed_items FROM pr_interventions WHERE execution_id=$1 AND revision=$2 AND completed_at IS NOT NULL AND confirmed_items IS NOT NULL',
          [id, context.control_revision - 1],
        )
      ).rows[0];
      const proof = (
        await client.query(
          "SELECT result->'data'->'environmentProof' AS proof FROM pr_commands WHERE execution_id=$1 AND kind='session.open' AND result->>'operationStatus'='SUCCEEDED'",
          [id],
        )
      ).rows[0]?.proof;
      const confirmations = context.definition.executionPlan
        ? (
            await client.query(
              'SELECT confirmed_condition_keys FROM pr_interventions WHERE execution_id=$1 AND auth_revision=$2 AND completed_at IS NOT NULL AND confirmed_condition_keys IS NOT NULL',
              [id, context.auth_revision],
            )
          ).rows.flatMap((row) => row.confirmed_condition_keys as string[])
        : [];
      return {
        ...(confirmation || confirmations.length
          ? {
              humanConfirmation: {
                revision: context.control_revision,
                items: confirmation?.confirmed_items ?? [],
                ...(context.definition.executionPlan
                  ? {
                      conditionKeys: [...new Set(confirmations)],
                      authRevision: context.auth_revision,
                    }
                  : {}),
              },
            }
          : {}),
        ...(proof ? { environmentProof: proof } : {}),
        authRevision: context.auth_revision,
        id,
        taskId: context.task_id,
        state: context.execution_state,
        taskState: context.task_state,
        controlMode: await confirmedControlMode(client, context),
        controlRevision: context.control_revision,
        controlReason: context.control_reason,
        actionCount: context.action_count,
        sessionId: context.session_id,
        sessionState: context.session_state,
        closureVerified: context.closure_verified,
        leaseExpiresAt: context.lease_expires_at,
        taskDeadlineAt: context.deadline_at,
        cleanupDeadlineAt: context.cleanup_deadline_at,
        stepBudget: context.budget_state,
        stepBudgets: context.budget_state?.steps,
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
    stepId?: string,
  ) {
    if (!operation.type.startsWith('browser.'))
      throw new ApiError(
        403,
        'CONTROL_COMMAND_FORBIDDEN',
        'Worker cannot manage node leases or sessions directly',
      );
    const actor = token === null ? 'HUMAN' : 'AGENT';
    if (operation.type === 'browser.identity.prepare')
      throw new ApiError(
        403,
        'IDENTITY_PREPARATION_FORBIDDEN',
        '本地登录配方已移除，请使用 DevPass 或当前会话人工登录',
      );
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
      canonical({
        timeoutMs,
        command: operation,
        actor,
        controlRevision,
        ...(stepId ? { stepId } : {}),
      }),
    );
    return this.db.transaction(async (client) => {
      const context = await executionContext(client, id);
      if (
        context.definition.sessionPlan?.external &&
        ['browser.auth.save', 'browser.identity.prepare'].includes(
          operation.type,
        )
      )
        throw new ApiError(
          403,
          'EXTERNAL_ACCOUNT_SAVE_FORBIDDEN',
          '外部账号仅限本次租约，不允许保存或切换登录配方',
        );
      if (operation.type === 'browser.auth.save')
        throw new ApiError(410, 'AUTH_SAVE_RETIRED', '案例不再保存身份基准');
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
      if (
        actor === 'AGENT' &&
        context.definition.profilePlan &&
        operation.type !== 'browser.trace'
      ) {
        const group = context.definition.profilePlan.groups.find((g) =>
          g.stepIds.includes(stepId ?? ''),
        );
        const expectedScope =
          group?.id ??
          (context.definition.cleanupStepIds?.includes(stepId ?? '')
            ? 'profile-cleanup'
            : undefined);
        if (
          !expectedScope ||
          !('tabScope' in operation) ||
          operation.tabScope !== expectedScope
        )
          throw new ApiError(
            403,
            'TAB_SCOPE_MISMATCH',
            '操作必须绑定当前步骤所属标签页',
          );
      } else if (
        !context.definition.profilePlan &&
        'tabScope' in operation &&
        operation.tabScope
      ) {
        throw new ApiError(
          403,
          'TAB_SCOPE_FORBIDDEN',
          '旧任务不能启用分组标签页',
        );
      }
      if (
        operation.type === 'browser.act' &&
        operation.action === 'pwa.cleanup' &&
        (actor !== 'AGENT' ||
          !context.definition.cleanupStepIds?.includes(stepId ?? ''))
      )
        throw new ApiError(
          403,
          'CLEANUP_SCOPE_FORBIDDEN',
          'PWA 清理只能在本用例的清理步骤执行',
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
      if (operation.type === 'browser.cookies.clear')
        await authorizeCookieCleanup(client, context, operation, actor);
      if (
        (
          await client.query(
            "SELECT 1 FROM pr_commands WHERE execution_id=$1 AND kind='session.control' AND result IS NULL",
            [id],
          )
        ).rowCount
      )
        throw new ApiError(409, 'SESSION_BUSY', '正在等待节点确认控制权');
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
      if (
        actor === 'AGENT' &&
        context.definition.stepBudget &&
        operation.type !== 'browser.trace'
      )
        await consumeStepBudget(
          client,
          context,
          ['browser.act', 'browser.cookies.clear'].includes(operation.type)
            ? 'actions'
            : 'observe',
          stepId,
        );
      if (
        actor === 'AGENT' &&
        ['browser.act', 'browser.cookies.clear'].includes(operation.type)
      ) {
        if (
          !context.definition.stepBudget &&
          context.action_count >= context.definition.budget.maxActions
        )
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
      // 人工点击、输入、导航的身份影响无法可靠推断；只读观察和滚动不改变认证版本。
      const authChanged =
        [
          'browser.cookies.set',
          'browser.cookies.clear',
          'browser.identity.prepare',
        ].includes(operation.type) ||
        (actor === 'HUMAN' &&
          ((operation.type === 'browser.input' &&
            operation.action !== 'scroll') ||
            operation.type === 'browser.act'));
      if (context.definition.executionPlan && authChanged) {
        context.auth_revision++;
        await client.query(
          'UPDATE pr_executions SET auth_revision=auth_revision+1 WHERE id=$1',
          [id],
        );
      }
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
    return this.reader.task(id);
  }

  /** 完成报告经过证据归属与标准覆盖校验；提交成功后立即撤销新的操作权限。 */
  async complete(
    id: string,
    token: string,
    report: VerificationReport,
    controlRevision = 0,
  ) {
    if (report.humanDecision)
      throw new ApiError(
        403,
        'HUMAN_RESULT_FORBIDDEN',
        '人工结论只能由人工处理服务提交',
      );
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
          executionTimeoutCode(context, 'TASK_DEADLINE'),
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
      else if (event.type === 'hitl.result' || event.type === 'hitl.finished')
        await this.humanEvent(client, connection.nodeId, event);
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
    if (heartbeat.nodeId !== connection.nodeId || heartbeat.pool !== pool)
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
      'UPDATE pr_nodes SET node_epoch=$2,capabilities=$3,inventory=$4,runtime=$5,public_url=$6,admission=$7,last_seen_at=clock_timestamp() WHERE id=$1',
      [
        connection.nodeId,
        heartbeat.nodeEpoch,
        heartbeat.capabilities,
        JSON.stringify(heartbeat.occupied),
        // 旧版进程不报版本时清空，避免降级后沿用上个进程的版本号。
        heartbeat.runtime ?? null,
        heartbeat.publicUrl ? directOrigin(heartbeat.publicUrl) : null,
        heartbeat.admission ?? null,
      ],
    );
    const sessions = await client.query(
      "SELECT execution_id,last_renew_request FROM pr_sessions WHERE node_id=$1 AND node_epoch=$2 AND state IN ('OPENING','ACTIVE')",
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
        !['STARTING', 'RUNNING'].includes(context.execution_state) ||
        context.lease_expires_at.getTime() <= Date.now() ||
        executionDeadline(context) <= Date.now()
      )
        continue;
      // 开启命令发出不等于节点已准入；只有心跳确认同租约的本机会话后才给启动阶段续租。
      // 既避免浏览器初始化耗尽短租约，也避免提前续租触发 SESSION_MISSING。
      if (
        context.session_state === 'OPENING' &&
        !heartbeat.occupied.some(
          (session) =>
            session.sessionId === context.session_id &&
            session.leaseId === context.lease_id &&
            session.fence === Number(context.fence) &&
            ['STARTING', 'ACTIVE'].includes(session.state),
        )
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
    if (!row) {
      const archived = (
        await client.query(
          'SELECT commands FROM pr_admission_rejections WHERE node_id=$1 AND session_id=$2',
          [nodeId, event.sessionId],
        )
      ).rows[0];
      const request = archived?.commands.find(
        (c: { id: string }) => c.id === event.commandId,
      )?.envelope as NodeCommand | undefined;
      if (
        request &&
        request.nodeEpoch === event.nodeEpoch &&
        request.leaseId === event.leaseId &&
        request.fence === event.fence &&
        event.nodeId === nodeId &&
        event.messageId === event.commandId
      )
        return;
      throw new ApiError(
        409,
        'COMMAND_MISSING',
        'Result has no durable command',
      );
    }
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
      'UPDATE pr_commands SET result=$2,completed_at=clock_timestamp() WHERE id=$1 AND result IS NULL',
      [event.commandId, result],
    );
    if (
      row.kind === 'session.open' &&
      event.operationStatus === 'FAILED' &&
      event.effect === 'NOT_STARTED' &&
      event.error?.code === 'RESOURCE_UNAVAILABLE' &&
      context.execution_state === 'STARTING' &&
      context.task_state === 'RUNNING'
    ) {
      // 只对节点证明尚未启动的资源拒绝重排；丢失响应和未知效果仍走关闭核实。
      const used = await client.query(
        "SELECT 1 FROM pr_commands WHERE execution_id=$1 AND kind LIKE 'browser.%' UNION ALL SELECT 1 FROM pr_model_calls WHERE execution_id=$1",
        [context.id],
      );
      if (used.rowCount)
        throw new ApiError(
          409,
          'ADMISSION_ALREADY_USED',
          '执行已经开始，不能重新调度',
        );
      await client.query(
        'INSERT INTO pr_admission_rejections(execution_id,task_id,node_id,session_id,commands,reason) SELECT $1,$2,$3,$4,jsonb_agg(to_jsonb(c)),$5 FROM pr_commands c WHERE execution_id=$1',
        [
          context.id,
          context.task_id,
          nodeId,
          context.session_id,
          event.error.message,
        ],
      );
      await client.query(
        "UPDATE pr_external_accounts SET state='ALLOCATED',session_id=NULL WHERE session_id=$1 AND state='IN_USE'",
        [context.session_id],
      );
      await client.query('DELETE FROM pr_commands WHERE execution_id=$1', [
        context.id,
      ]);
      await client.query('DELETE FROM pr_sessions WHERE execution_id=$1', [
        context.id,
      ]);
      await client.query(
        'DELETE FROM pr_control_events WHERE execution_id=$1',
        [context.id],
      );
      await client.query('DELETE FROM pr_executions WHERE id=$1', [context.id]);
      await client.query(
        "UPDATE pr_tasks SET state='QUEUED',deadline_at=COALESCE(queue_deadline_at,deadline_at),queue_reason=$2 WHERE id=$1",
        [
          context.task_id,
          {
            code: 'NODE_CAPACITY',
            message: '节点当前资源不足，等待资源恢复或其他节点接收。',
          },
        ],
      );
      await client.query(
        "UPDATE pr_nodes SET admission_retry_at=clock_timestamp()+interval '5 seconds' WHERE id=$1",
        [nodeId],
      );
      return;
    }
    if (row.kind === 'session.control') {
      if (
        event.operationStatus === 'SUCCEEDED' &&
        typeof event.data?.authRevision === 'number'
      )
        await client.query(
          'UPDATE pr_executions SET auth_revision=GREATEST(auth_revision,$2) WHERE id=$1',
          [context.id, event.data.authRevision],
        );
      if (
        event.operationStatus !== 'SUCCEEDED' &&
        !('grant' in request.command) &&
        context.task_state === 'RUNNING'
      )
        await stopExecution(client, context, 'ERROR', 'CONTROL_HANDOFF_FAILED');
    }
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
        // 配置意图不能替代浏览器回读；旧节点缺失证明时不得宣称新偏好已生效。
        if (
          request.command.type === 'session.open' &&
          request.command.reducedMotion !== undefined
        ) {
          const proof = event.data?.environmentProof as
            Record<string, unknown> | undefined;
          if (
            proof?.sessionId !== request.sessionId ||
            proof?.reducedMotion !== request.command.reducedMotion
          ) {
            await stopExecution(
              client,
              context,
              'ERROR',
              'MOTION_PREFERENCE_MISMATCH',
            );
            return;
          }
        }
        // 节点成功启动不等于注入了正确材料；公开回执必须绑定原会话与租约。
        if (
          request.command.type === 'session.open' &&
          request.command.externalAccount
        ) {
          const proof = event.data?.environmentProof as
            Record<string, unknown> | undefined;
          const actual = proof?.externalAccount as
            Record<string, unknown> | undefined;
          const expected = request.command.externalAccount;
          if (
            proof?.sessionId !== request.sessionId ||
            proof?.initialState !== 'external' ||
            actual?.leaseId !== expected.leaseId ||
            actual?.materialVersion !== expected.materialVersion ||
            actual?.origin !== expected.origin ||
            actual?.ttlMs !== expected.ttlMs
          ) {
            await stopExecution(
              client,
              context,
              'ERROR',
              'EXTERNAL_ACCOUNT_PROOF_MISMATCH',
            );
            return;
          }
        }
        await client.query(
          "UPDATE pr_sessions SET state='ACTIVE' WHERE id=$1 AND state='OPENING'",
          [context.session_id],
        );
        await client.query(
          "UPDATE pr_executions SET state='RUNNING' WHERE id=$1 AND state='STARTING'",
          [context.id],
        );
      } else if (
        !staleRenewal(row.kind as string, event) &&
        ((event.effect === 'MAY_HAVE_HAPPENED' &&
          !recoverableObservationFailure(row.kind, event) &&
          !recoverableFocusFailure(request.command, event)) ||
          (['session.open', 'session.renew'].includes(row.kind as string) &&
            event.operationStatus !== 'SUCCEEDED'))
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
    // 原始关闭原因独立于清理结果持久化；未知旧节点保留空值。
    await client.query(
      'UPDATE pr_sessions SET close_reason=COALESCE(close_reason,$2) WHERE id=$1',
      [context.session_id, event.closeReason ?? null],
    );
    if (context.closure_verified) return;
    if (context.task_state === 'RUNNING')
      await stopExecution(
        client,
        context,
        'ERROR',
        event.closeReason ?? 'SESSION_ENDED',
      );
    if (event.closureVerified) await releaseSession(client, context);
    else
      await client.query(
        "UPDATE pr_sessions SET state='QUARANTINED' WHERE id=$1",
        [context.session_id],
      );
  }

  /** 到期、清理和投递使用同一个有界循环；调用方保证不会重入。 */
  async tick(): Promise<void> {
    if (!this.db.healthy)
      throw new ApiError(
        503,
        'DATABASE_UNAVAILABLE',
        'Database ownership unavailable',
      );
    this.externalAccounts.kick();
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
      WHERE e.state IN ('STARTING','RUNNING') AND (EXISTS(SELECT 1 FROM pr_sessions s WHERE s.execution_id=e.id AND s.external_expires_at<=clock_timestamp()) OR e.lease_expires_at<=clock_timestamp() OR t.cleanup_deadline_at<=clock_timestamp() OR (e.control_mode<>'AUTO' AND e.human_deadline_at<=clock_timestamp()) OR (e.control_mode='AUTO' AND t.deadline_at<=clock_timestamp())) LIMIT $1`,
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
            executionTimeoutCode(context),
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
        await client.query(
          'UPDATE pr_commands SET result=$2,completed_at=clock_timestamp() WHERE id=$1',
          [
            command.id,
            syntheticResult(
              command.envelope,
              Boolean(command.first_sent_at),
              'DEADLINE_EXCEEDED',
            ),
          ],
        );
        // 续期回执缺失只结束本条命令；新的心跳仍可续期，本地租约或 worker 真正过期时另行撤权。
        if (
          !['session.close', 'session.renew'].includes(command.kind) &&
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
      ORDER BY CASE c.kind WHEN 'session.close' THEN 0 WHEN 'session.renew' THEN 1 WHEN 'session.control' THEN 2 ELSE 3 END,c.created_at LIMIT $2`,
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
          envelope.command.type === 'session.control' ||
          envelope.command.type.startsWith('browser.')
        ) {
          const pending = await client.query(
            "SELECT 1 FROM pr_commands WHERE session_id=$1 AND kind='session.control' AND result IS NULL AND id<>$2 AND (created_at,id)<(SELECT created_at,id FROM pr_commands WHERE id=$2)",
            [context.session_id, row.id],
          );
          if (pending.rowCount) return null;
        }
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
      if (command) {
        if (
          command.command.type === 'session.open' &&
          command.command.externalAccount
        ) {
          const task = (
            await this.db.query<{ task_id: string }>(
              'SELECT task_id FROM pr_executions WHERE id=$1',
              [row.execution_id],
            )
          ).rows[0]!;
          if (
            !(await this.externalAccounts.attach(task.task_id, command.command))
          )
            continue;
        }
        await this.gateway.send(command);
      }
    }
  }
}

/** 心跳公开地址必须是 HTTPS origin，防止将令牌发送给路径、明文公网或含凭据地址。 */
function directOrigin(value: string): string {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new ApiError(
      400,
      'NODE_PUBLIC_URL',
      '节点直连地址必须是 HTTPS origin',
    );
  return url.origin;
}

/** AUTO 决定已提交但节点尚未确认时，worker 继续等待，不能使用旧观察派发动作。 */
async function confirmedControlMode(
  client: PoolClient,
  context: ExecutionContext,
): Promise<'AUTO' | 'REQUESTED' | 'HUMAN'> {
  if (context.control_mode !== 'AUTO') return context.control_mode;
  const pending = await client.query(
    "SELECT 1 FROM pr_commands WHERE execution_id=$1 AND kind='session.control' AND envelope#>>'{command,mode}'='AUTO' AND result IS NULL",
    [context.id],
  );
  return pending.rowCount ? 'HUMAN' : 'AUTO';
}
