import { randomUUID } from 'node:crypto';
import {
  AccountLease,
  DevPassClient,
  type JournalEntry,
} from '@dev-pass/client';
import {
  normalizeOrigin,
  type GetAccountInput,
  type ReleaseAccountInput,
} from '@dev-pass/contracts';
import type { NodeCommand, VerificationTask } from '@proofrun/contracts';
import type { PoolClient } from 'pg';
import { Database } from '../../db.js';
import { ApiError } from '../../domain.js';
import { executionContext, stopExecution } from '../scheduling/state.js';
import { privateText, type DevPassConfig } from './config.js';
import { ACCOUNT_CLOSE_MARGIN_MS, ACCOUNT_HUMAN_MARGIN_MS } from './policy.js';
import { PREPARATION_MS } from '../identities/catalog.js';
export { ACCOUNT_CLOSE_MARGIN_MS } from './policy.js';

/** 准备预留有界；账号分配在事务外，不占用浏览器进程或数据库行锁。 */
const RESERVATION_MS = 30_000;
/** 每次扫描最多启动四个外部操作，避免 MCP 故障影响网关续租。 */
const CONCURRENCY = 4;
/** 不确定响应沿用原申请；业务不可用和传输失败均采用有界退避。 */
const RETRY_MS = 30_000;

/** 数据库只保存申请、公开账号事实与交还意图，不保存材料或 JWE。 */
interface Binding {
  /** 唯一归属任务；终态不能重新申请。 */
  task_id: string;
  /** 跨重启沿用的全局随机申请键。 */
  request_id: string;
  /** 首次申请的冻结参数。 */
  request: GetAccountInput;
  /** 部署中配置的来源引用。 */
  provider_id: string;
  /** 首次申请的 DevPass 调用方身份。 */
  client_id: string;
  /** 预留节点，创建会话后不可转移。 */
  node_id: string;
  /** 浏览器尚未启动时的短期容量预留。 */
  reserved_until: Date;
  /** 当前分配或交还阶段。 */
  state: string;
  /** SDK 持久意图，不含认证材料。 */
  journal: Record<string, JournalEntry>;
  /** 解密之前即保存的远端租约。 */
  lease_id: string | null;
  /** DevPass 冻结的绝对到期时间。 */
  expires_at: Date | null;
  /** 实际占用材料的唯一浏览器会话。 */
  session_id: string | null;
  /** 已分配账号的公开身份。 */
  account_id: string | null;
  /** 双跑需要保持一致的材料版本。 */
  material_version: string | null;
  /** 首次交还时冻结的结论，自动错误不污染账号健康。 */
  release_outcome: ReleaseAccountInput['outcome'] | null;
}
type Open = Extract<NodeCommand['command'], { type: 'session.open' }>;

/** 单主控制面的外部租约管理；只缓存私有材料，持久事实以 PostgreSQL 为准。 */
export class ExternalAccounts {
  /** 同一任务只允许一个外部写入者。 */
  private readonly busy = new Map<string, Promise<void>>();
  /** 解密材料仅驻留内存，关闭或重启即丢弃。 */
  private readonly materials = new Map<string, AccountLease>();
  /** 避免定时器重入扫描。 */
  private scanPromise: Promise<void> | undefined;
  /** 停机后禁止启动新请求。 */
  private stopped = false;
  constructor(
    private readonly db: Database,
    private readonly config?: DevPassConfig,
  ) {}

  /** 在提交时发现来源或预算错误；幂等重提不改变已冻结任务。 */
  validate(task: VerificationTask): void {
    const plan = task.sessionPlan?.external;
    if (!plan) return;
    if (!this.config || plan.selector.provider !== this.config.id)
      throw new ApiError(
        422,
        'EXTERNAL_ACCOUNT_PROVIDER',
        '未配置所选 DevPass 来源',
      );
    try {
      normalizeOrigin(plan.origin, this.config.allowLoopback);
    } catch {
      throw new ApiError(
        422,
        'EXTERNAL_ACCOUNT_ORIGIN',
        '外部账号需要 HTTPS 来源或明确启用的本机回环来源',
      );
    }
    if (plan.durationSeconds > this.config.maxDurationSeconds)
      throw new ApiError(
        422,
        'EXTERNAL_ACCOUNT_BUDGET',
        '所需账号期限超过 DevPass 调用方上限',
      );
    // 重跑允许扩展步骤预算，但不能沿用短于实际执行的旧账号期限。
    const required =
      task.budget.timeoutMs +
      (task.stepBudget?.settleMs ?? 0) *
        (task.stepBudget?.steps.filter(
          (step) => !task.cleanupStepIds?.includes(step.stepId),
        ).length ?? 0) +
      (task.cleanupStepIds?.length
        ? (task.stepBudget?.cleanup.timeoutMs ?? 180_000)
        : 0) +
      PREPARATION_MS +
      ACCOUNT_HUMAN_MARGIN_MS +
      ACCOUNT_CLOSE_MARGIN_MS;
    if (plan.durationSeconds * 1000 < required)
      throw new ApiError(
        422,
        'EXTERNAL_ACCOUNT_BUDGET',
        '重跑预算超过冻结账号期限，请提交新的完整 Case',
      );
  }

  /** 在节点容量锁内预留或领取；外部网络请求由扫描器异步处理。 */
  async reserve(
    tx: PoolClient,
    task: VerificationTask,
    nodeId: string,
  ): Promise<Binding | null> {
    const plan = task.sessionPlan!.external!;
    const existing = (
      await tx.query<Binding>(
        'SELECT * FROM pr_external_accounts WHERE task_id=$1 FOR UPDATE',
        [task.taskId],
      )
    ).rows[0];
    if (existing) {
      if (
        existing.state === 'REQUESTED' &&
        existing.reserved_until <= new Date()
      )
        await tx.query(
          "UPDATE pr_external_accounts SET node_id=$2,reserved_until=clock_timestamp()+$3*interval '1 millisecond' WHERE task_id=$1",
          [task.taskId, nodeId, RESERVATION_MS],
        );
      if (
        existing.state === 'ALLOCATED' &&
        !existing.session_id &&
        existing.reserved_until > new Date() &&
        existing.expires_at!.getTime() > Date.now() + ACCOUNT_CLOSE_MARGIN_MS &&
        this.materials.has(task.taskId)
      ) {
        // 尚未启动浏览器的材料可转给当前兼容节点；绑定后不允许迁移。
        await tx.query(
          'UPDATE pr_external_accounts SET node_id=$2 WHERE task_id=$1',
          [task.taskId, nodeId],
        );
        return { ...existing, node_id: nodeId };
      }
      return null;
    }
    this.validate(task);
    // 首组先固定账号，另一组使用同账号申请独立额度；不能竞争分配出两个不同账号。
    let paired:
      | {
          account_id: string | null;
          material_version: string | null;
          state: string;
        }
      | undefined;
    if (task.comparison) {
      const primary = task.comparison.sourceTaskId;
      if (task.taskId !== primary) {
        paired = (
          await tx.query(
            'SELECT a.account_id,a.material_version,t.state FROM pr_tasks t LEFT JOIN pr_external_accounts a ON a.task_id=t.id WHERE t.id=$1',
            [primary],
          )
        ).rows[0];
        if (!paired?.account_id) {
          if (paired && !['QUEUED', 'RUNNING'].includes(paired.state))
            await tx.query(
              "UPDATE pr_tasks SET state='ERROR',finished_at=clock_timestamp(),error=jsonb_build_object('code','EXTERNAL_ACCOUNT_COMPARISON_UNAVAILABLE') WHERE id=$1 AND state='QUEUED'",
              [task.taskId],
            );
          return null;
        }
      }
    }
    const requestId = `pr-${randomUUID()}`;
    const request: GetAccountInput = {
      request_id: requestId,
      platform: plan.selector.platform,
      origin: plan.origin,
      accepted_material_types: ['browser_cookies'],
      duration_seconds: plan.durationSeconds,
      role_description: plan.selector.roles ?? [],
      ...(plan.selector.poolId ? { pool_id: plan.selector.poolId } : {}),
      ...(paired?.account_id || plan.selector.accountId
        ? { account_id: paired?.account_id ?? plan.selector.accountId! }
        : {}),
    };
    await tx.query(
      `INSERT INTO pr_external_accounts(task_id,request_id,request,provider_id,client_id,node_id,reserved_until)
      VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+$7*interval '1 millisecond')`,
      [
        task.taskId,
        requestId,
        request,
        this.config!.id,
        this.config!.clientId,
        nodeId,
        RESERVATION_MS,
      ],
    );
    return null;
  }

  /** 绑定与会话创建处于同一事务，未绑定的材料不能下发。 */
  async bind(tx: PoolClient, taskId: string, sessionId: string): Promise<void> {
    await tx.query(
      "UPDATE pr_external_accounts SET state='IN_USE',session_id=$2 WHERE task_id=$1 AND state='ALLOCATED'",
      [taskId, sessionId],
    );
  }

  /** 只有管理员明确确认的账号异常才能反馈 DevPass；模型报告不会自动改变账号健康。 */
  async feedback(taskId: string, input: unknown): Promise<void> {
    const body = input as { outcome?: string; reason?: string } | null;
    if (
      !body ||
      Object.keys(body).some((k) => !['outcome', 'reason'].includes(k)) ||
      ![
        'credential_invalid',
        'identity_mismatch',
        'account_state_changed',
      ].includes(body.outcome ?? '') ||
      typeof body.reason !== 'string' ||
      !body.reason.trim() ||
      body.reason.length > 1000
    )
      throw new ApiError(
        400,
        'INVALID_ACCOUNT_FEEDBACK',
        '需要明确的账号异常类型和不含秘密的核实原因',
      );
    await this.db.transaction(async (tx) => {
      // 先锁任务再锁账号，与领取路径保持相同顺序。
      await tx.query('SELECT id FROM pr_tasks WHERE id=$1 FOR UPDATE', [
        taskId,
      ]);
      const row = (
        await tx.query<Binding>(
          'SELECT * FROM pr_external_accounts WHERE task_id=$1 FOR UPDATE',
          [taskId],
        )
      ).rows[0];
      if (!row?.lease_id)
        throw new ApiError(
          409,
          'EXTERNAL_ACCOUNT_MISSING',
          '尚无可反馈的外部账号租约',
        );
      if (row.release_outcome || ['RELEASED', 'REVIEW'].includes(row.state))
        throw new ApiError(
          409,
          'ACCOUNT_FEEDBACK_FROZEN',
          '交还结论已经冻结，不能改写',
        );
      await tx.query(
        'UPDATE pr_external_accounts SET release_outcome=$2,reason=$3 WHERE task_id=$1',
        [taskId, body.outcome, body.reason!.trim()],
      );
    });
    await this.fail(taskId, 'EXTERNAL_ACCOUNT_CONFIRMED_INVALID');
  }

  /** 只读取缓存中的已校验材料；缺失时等待后台原键恢复，不阻塞网关投递。 */
  async attach(taskId: string, command: Open): Promise<boolean> {
    const lease = this.materials.get(taskId);
    if (!lease || lease.signal.aborted) return false;
    const remaining =
      Date.parse(lease.result.lease.expires_at) -
      Date.now() -
      ACCOUNT_CLOSE_MARGIN_MS;
    if (remaining <= 0) return false;
    await lease.useMaterial(async (material) => {
      if (material.type !== 'browser_cookies')
        throw new Error('外部材料类型不支持');
      command.externalCookies = structuredClone(material.cookies);
      if (
        !command.externalAccount ||
        command.externalAccount.leaseId !== lease.result.lease.id ||
        command.externalAccount.materialVersion !==
          lease.result.account.material.version ||
        command.externalAccount.origin !== lease.result.account.origin
      )
        throw new Error('外部材料与会话绑定不一致');
    });
    return true;
  }

  /** 定时入口只启动有界后台工作，MCP 超时不能拖延节点心跳。 */
  kick(): void {
    if (this.stopped || this.scanPromise || !this.db.healthy) return;
    this.scanPromise = this.scan()
      .catch(() => {})
      .finally(() => {
        this.scanPromise = undefined;
      });
  }

  private async scan(): Promise<void> {
    const rows = (
      await this.db.query<Binding>(
        `SELECT * FROM pr_external_accounts WHERE state NOT IN ('RELEASED','REVIEW') AND retry_at<=clock_timestamp() ORDER BY retry_at LIMIT 32`,
      )
    ).rows;
    for (const row of rows) {
      if (this.stopped || this.busy.size >= CONCURRENCY) break;
      if (this.busy.has(row.task_id)) continue;
      const work = this.reconcile(row)
        .catch(async () => {
          await this.db
            .query(
              "UPDATE pr_external_accounts SET reason='EXTERNAL_ACCOUNT_TRANSPORT',retry_at=clock_timestamp()+$2*interval '1 millisecond' WHERE task_id=$1",
              [row.task_id, RETRY_MS],
            )
            .catch(() => {});
        })
        .finally(() => {
          this.busy.delete(row.task_id);
        });
      this.busy.set(row.task_id, work);
    }
  }

  /** 每个任务独占账本；SDK 在解密前写入 leaseId，解密失败仍能可靠交还。 */
  private async connect(row: Binding): Promise<DevPassClient> {
    const config = this.config;
    if (
      !config ||
      config.id !== row.provider_id ||
      config.clientId !== row.client_id
    )
      throw new Error('外部来源配置与冻结租约不一致');
    return DevPassClient.connect({
      url: config.url,
      token: privateText(config.tokenFile),
      clientId: config.clientId,
      ...(config.allowLoopback ? { allowLoopback: true } : {}),
      resolvePrivateKey: async (key) => {
        const file = Object.hasOwn(config.privateKeyFiles, key)
          ? config.privateKeyFiles[key]
          : undefined;
        if (!file) throw new Error('租约接收密钥尚未配置');
        return privateText(file);
      },
      journalStore: {
        load: async () =>
          (
            await this.db.query<Binding>(
              'SELECT journal FROM pr_external_accounts WHERE task_id=$1',
              [row.task_id],
            )
          ).rows[0]!.journal,
        save: async (journal) => {
          if (!this.db.healthy) throw new Error('数据库所有权已丢失');
          const entry = journal[row.request_id];
          await this.db.query(
            'UPDATE pr_external_accounts SET journal=$2,lease_id=COALESCE(lease_id,$3),expires_at=COALESCE(expires_at,$4) WHERE task_id=$1',
            [
              row.task_id,
              journal,
              entry?.lease_id ?? null,
              entry?.expires_at ?? null,
            ],
          );
        },
      },
    });
  }

  /** 过期与资源停止分别处理；业务终态不会跳过远端关闭核实。 */
  private async reconcile(row: Binding): Promise<void> {
    const task = (
      await this.db.query<{ state: string; definition: VerificationTask }>(
        'SELECT state,definition FROM pr_tasks WHERE id=$1',
        [row.task_id],
      )
    ).rows[0]!;
    // 明确反馈持久化后即构成终止意图，崩溃恢复也不能继续使用异常账号。
    if (
      row.release_outcome &&
      [
        'credential_invalid',
        'identity_mismatch',
        'account_state_changed',
      ].includes(row.release_outcome) &&
      ['QUEUED', 'RUNNING'].includes(task.state)
    ) {
      await this.fail(row.task_id, 'EXTERNAL_ACCOUNT_CONFIRMED_INVALID');
      task.state = 'ERROR';
    }
    if (
      row.expires_at &&
      row.expires_at.getTime() <= Date.now() + ACCOUNT_CLOSE_MARGIN_MS &&
      ['QUEUED', 'RUNNING'].includes(task.state)
    ) {
      await this.fail(row.task_id, 'EXTERNAL_ACCOUNT_EXPIRED');
      task.state = 'ERROR';
    }
    if (
      row.state === 'ALLOCATED' &&
      !row.session_id &&
      row.reserved_until <= new Date()
    ) {
      // 与领取事务争用任务行，已开始执行的任务不能因旧预留快照被误杀。
      const expired = await this.db.query(
        `UPDATE pr_tasks SET state='ERROR',finished_at=clock_timestamp(),error=jsonb_build_object('code','EXTERNAL_ACCOUNT_RESERVATION_EXPIRED')
         WHERE id=$1 AND state='QUEUED' AND EXISTS(SELECT 1 FROM pr_external_accounts WHERE task_id=$1 AND session_id IS NULL AND reserved_until<=clock_timestamp())`,
        [row.task_id],
      );
      if (expired.rowCount) task.state = 'ERROR';
    }
    const terminal = !['QUEUED', 'RUNNING'].includes(task.state);
    // 任务终态不可逆；重新读取绑定，避免扫描后才创建的会话被误判为从未启动。
    if (terminal)
      row = (
        await this.db.query<Binding>(
          'SELECT * FROM pr_external_accounts WHERE task_id=$1',
          [row.task_id],
        )
      ).rows[0]!;
    if (terminal && row.lease_id) {
      const stopped =
        !row.session_id ||
        (
          await this.db.query(
            'SELECT closure_verified FROM pr_sessions WHERE id=$1',
            [row.session_id],
          )
        ).rows[0]?.closure_verified === true;
      const outcome =
        row.release_outcome ??
        (task.state === 'COMPLETED'
          ? 'completed'
          : task.state === 'CANCELLED'
            ? 'cancelled'
            : 'execution_error');
      this.materials.get(row.task_id)?.close();
      this.materials.delete(row.task_id);
      const frozen = (
        await this.db.query<Pick<Binding, 'release_outcome'>>(
          "UPDATE pr_external_accounts SET state='RELEASE_PENDING',release_outcome=COALESCE(release_outcome,$2) WHERE task_id=$1 RETURNING release_outcome",
          [row.task_id, outcome],
        )
      ).rows[0]!.release_outcome!;
      const client = await this.connect(row);
      try {
        const result = stopped
          ? await client.releaseStopped(
              row.lease_id,
              frozen,
              'ProofRun 已确认执行资源停止',
            )
          : await client.reportNotStopped(
              row.lease_id,
              frozen,
              'ProofRun 尚未确认浏览器关闭',
            );
        await this.db.query(
          "UPDATE pr_external_accounts a SET state=$2,retry_at=CASE WHEN $2='RELEASE_PENDING' AND EXISTS(SELECT 1 FROM pr_sessions s WHERE s.id=a.session_id AND s.closure_verified) THEN clock_timestamp() ELSE clock_timestamp()+$3*interval '1 millisecond' END WHERE task_id=$1",
          [
            row.task_id,
            stopped && result.status === 'released'
              ? 'RELEASED'
              : 'RELEASE_PENDING',
            RETRY_MS,
          ],
        );
      } finally {
        await client.disconnect();
      }
      return;
    }
    if (terminal && !row.lease_id && !Object.keys(row.journal).length) {
      await this.db.query(
        "UPDATE pr_external_accounts SET state='RELEASED' WHERE task_id=$1",
        [row.task_id],
      );
      return;
    }
    if (
      !terminal &&
      (this.materials.has(row.task_id) ||
        (row.state === 'REQUESTED' && row.reserved_until <= new Date()))
    ) {
      // 让出扫描窗口，避免大量健康会话阻塞后续交还。
      await this.db.query(
        "UPDATE pr_external_accounts SET retry_at=clock_timestamp()+interval '1 second' WHERE task_id=$1",
        [row.task_id],
      );
      return;
    }
    const client = await this.connect(row);
    try {
      const result = await client.getAccount(row.request);
      if (!(result instanceof AccountLease)) {
        const retryable =
          result.status === 'unavailable'
            ? result.reason === 'CAPACITY_EXHAUSTED'
            : result.error.retryable;
        const reason =
          result.status === 'unavailable' ? result.reason : result.error.code;
        if (row.lease_id) {
          // 恢复失败不代表旧租约已释放；保留可扫描的交还阶段，关闭事实仍由下一轮核实。
          await this.fail(row.task_id, `EXTERNAL_ACCOUNT_${reason}`);
          await this.db.query(
            "UPDATE pr_external_accounts SET state='RELEASE_PENDING',reason=$2,retry_at=clock_timestamp() WHERE task_id=$1",
            [row.task_id, reason],
          );
          return;
        }
        await this.db.query(
          "UPDATE pr_external_accounts SET state=$2,reason=$3,reserved_until=clock_timestamp(),retry_at=clock_timestamp()+$4*interval '1 millisecond' WHERE task_id=$1",
          [
            row.task_id,
            retryable && !terminal ? 'REQUESTED' : 'REVIEW',
            reason,
            RETRY_MS,
          ],
        );
        if (!retryable || terminal)
          await this.fail(row.task_id, `EXTERNAL_ACCOUNT_${reason}`);
        return;
      }
      // 同轮只比较相同账号与材料；DevPass 不能按旧版本申请，差异不能伪装成策略差异。
      const primary = task.definition.comparison?.sourceTaskId;
      if (primary && primary !== row.task_id) {
        const paired = (
          await this.db.query<Binding>(
            'SELECT * FROM pr_external_accounts WHERE task_id=$1',
            [primary],
          )
        ).rows[0];
        if (
          !paired ||
          paired.account_id !== result.result.account.id ||
          paired.material_version !== result.result.account.material.version
        ) {
          result.close();
          await this.fail(row.task_id, 'EXTERNAL_ACCOUNT_COMPARISON_CHANGED');
          return;
        }
      }
      await this.db.query(
        `UPDATE pr_external_accounts SET state=CASE WHEN session_id IS NULL THEN 'ALLOCATED' ELSE 'IN_USE' END,
        account_id=$2,material_version=$3,account_summary=$4,reason=NULL,reserved_until=clock_timestamp()+$5*interval '1 millisecond' WHERE task_id=$1`,
        [
          row.task_id,
          result.result.account.id,
          result.result.account.material.version,
          result.publicAccount(),
          RESERVATION_MS,
        ],
      );
      this.materials.set(row.task_id, result);
    } catch {
      const saved = (
        await this.db.query<Binding>(
          'SELECT * FROM pr_external_accounts WHERE task_id=$1',
          [row.task_id],
        )
      ).rows[0]!;
      if (saved.lease_id)
        await this.fail(row.task_id, 'EXTERNAL_ACCOUNT_MATERIAL_UNAVAILABLE');
      throw new Error('外部账号申请或解密失败');
    } finally {
      await client.disconnect();
    }
  }

  /** 未执行业务的环境错误不生成产品失败；已开始任务沿用可靠关闭流程。 */
  private async fail(taskId: string, code: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      // 先锁任务再查询执行，防止领取恰好在查询之后提交而漏掉需关闭的会话。
      await tx.query('SELECT id FROM pr_tasks WHERE id=$1 FOR UPDATE', [
        taskId,
      ]);
      const executions = await tx.query(
        'SELECT id FROM pr_executions WHERE task_id=$1',
        [taskId],
      );
      for (const e of executions.rows) {
        const context = await executionContext(tx, e.id);
        if (context.task_state === 'RUNNING')
          await stopExecution(tx, context, 'ERROR', code);
      }
      await tx.query(
        "UPDATE pr_tasks SET state='ERROR',finished_at=clock_timestamp(),error=jsonb_build_object('code',$2::text,'message','外部账号环境不可用，未确认的验收范围不能视为通过') WHERE id=$1 AND state='QUEUED'",
        [taskId, code],
      );
    });
  }

  /** 关闭只结束本地连接与材料引用，未确认资源停止的租约由下次启动继续恢复。 */
  async close(): Promise<void> {
    this.stopped = true;
    await this.scanPromise;
    await Promise.allSettled(this.busy.values());
    for (const lease of this.materials.values()) lease.close();
    this.materials.clear();
  }
}
