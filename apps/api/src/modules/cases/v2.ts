import { refreshExternalSessionBudget } from '../sessions/budget.js';
import { projectCase } from './projection.js';
import type { TaskReader } from '../tasks/reader.js';
import { assertSupportedSession, usesLocalIdentity } from '../sessions/plan.js';
import {
  validateVerificationCaseV2,
  validateSessionRequest,
  type CaseResultV2,
  type VerificationTask,
} from '@proofrun/contracts';
import { ApiError, canonical } from '../../domain.js';
import type { Coordinator } from '../scheduling/coordinator.js';
import { validateCaseProfile, type CaseProfile } from './profile.js';
import { extendRerunTimeBudget, parseRerunTimeBudget } from './rerun-budget.js';
import {
  caseArmIds,
  compileCase,
  MAX_CASE_BATCH,
  V2_PREFIX,
} from './structured.js';

/** 新旧公开入口各自投影结果；不将平台配置或浏览器会话凭据返回上游。 */
export class CaseV2Service {
  constructor(
    /** 复用控制面的任务、清理和原子提交端口。 */
    private readonly tasks: Pick<Coordinator, 'submitCaseBatch' | 'cancel'> &
      Pick<TaskReader, 'task' | 'caseCleanup'> &
      Partial<Pick<TaskReader, 'caseTask'>>,
    /** 首次接收使用的平台配置；幂等重提使用已冻结快照。 */
    private readonly profile: CaseProfile | undefined,
    /** 构造同源公开证据地址，不透传内部报告地址。 */
    private readonly publicUrl: string,
  ) {}

  /** 身份不是任意内部任务路径；清理结果也只通过所属 case 读取。 */
  private async stored(id: string, runId?: string) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id))
      throw new ApiError(404, 'CASE_MISSING', 'Case not found');
    const task = await (
      this.tasks.caseTask
        ? this.tasks.caseTask(id, runId)
        : this.tasks.task(runId ?? `${V2_PREFIX}${id}`)
    ).catch((error: unknown) => {
      if (error instanceof ApiError && error.code === 'TASK_MISSING')
        throw new ApiError(404, 'CASE_MISSING', 'Case not found');
      throw error;
    });
    if (task.definition.caseV2Definition?.caseId !== id)
      throw new ApiError(404, 'CASE_MISSING', 'Case not found');
    return task;
  }

  /** 先校验整批，再由调度器事务接收；配置改变后重提仍复用首次冻结的快照。 */
  async prepare(input: unknown): Promise<VerificationTask[]> {
    if (
      !Array.isArray(input) ||
      !input.length ||
      input.length > MAX_CASE_BATCH ||
      !input.every((item) => validateVerificationCaseV2(item))
    )
      throw new ApiError(
        400,
        'INVALID_CASE',
        '请求必须为 1–32 个结构化 case 的数组',
      );
    if (new Set(input.map((item) => item.caseId)).size !== input.length)
      throw new ApiError(422, 'INVALID_CASE', '批次内 caseId 不能重复');
    const definitions: VerificationTask[] = [];
    for (const item of input) {
      const existing = await this.stored(item.caseId).catch(
        (error: unknown) => {
          if (error instanceof ApiError && error.code === 'CASE_MISSING')
            return null;
          throw error;
        },
      );
      if (existing) {
        if (canonical(existing.definition.caseV2Definition) !== canonical(item))
          throw new ApiError(409, 'CASE_CONFLICT', 'caseId 已绑定另一份定义');
        definitions.push(existing.definition);
      } else {
        if (!this.profile)
          throw new ApiError(
            503,
            'CASE_NOT_CONFIGURED',
            '平台未配置 case 执行环境',
          );
        const compiled = compileCase(item, validateCaseProfile(this.profile));
        definitions.push(compiled);
      }
    }
    return definitions;
  }

  /** 旧数组入口继续按 case 幂等，不推测请求归属。 */
  async submit(input: unknown): Promise<CaseResultV2[]> {
    const definitions = await this.prepare(input);
    await this.tasks.submitCaseBatch(definitions);
    return Promise.all(
      definitions.map((item) => this.get(item.caseV2Definition!.caseId)),
    );
  }

  /** 重跑从当前主组恢复定义；caseId 稳定，runId 独立冻结配置和执行结果。 */
  async prepareRerun(
    id: string,
    runId: unknown,
    budgetMode: 'current' | 'original' = 'current',
    timeBudget?: unknown,
    // 请求内重跑沿用该请求当前运行，避免共享 case 被其他请求的新运行改变配置。
    sourceTaskId?: string,
    session?: unknown,
  ): Promise<VerificationTask> {
    if (typeof runId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(runId))
      throw new ApiError(400, 'INVALID_RERUN', '重跑需要一个有效 runId');
    const replacement = validateSessionRequest(session) ? session : undefined;
    if (session !== undefined && !replacement)
      throw new ApiError(
        400,
        'INVALID_RERUN',
        '会话配置无效；省略时自动判断身份，也可提供有效的显式会话约束',
      );
    const time = parseRerunTimeBudget(timeBudget);
    const taskId = `case-run-${runId}`;
    const previous = await this.tasks.task(taskId).catch((error: unknown) => {
      if (error instanceof ApiError && error.code === 'TASK_MISSING')
        return null;
      throw error;
    });
    if (previous) {
      assertSupportedSession(previous.definition.sessionPlan);
      if (previous.definition.caseV2Definition?.caseId !== id)
        throw new ApiError(409, 'CASE_CONFLICT', 'runId 已属于其他 case');
      if (
        canonical(previous.definition.rerunSession ?? null) !==
        canonical(session ?? null)
      )
        throw new ApiError(
          409,
          'CASE_CONFLICT',
          'runId 已绑定另一份会话配置，请使用新的 runId',
        );
      return previous.definition;
    }
    const { definition } = await this.stored(id, sourceTaskId);
    if (
      budgetMode === 'original' &&
      (definition.comparison ||
        (definition.executionMode && definition.executionMode !== 'llm'))
    )
      throw new ApiError(
        422,
        'RERUN_BUDGET_INCOMPATIBLE',
        '历史 JEV/双跑预算不能用于新执行，请选择当前预算',
      );
    const profile: CaseProfile = {
      // 保留原人工权限；退役身份迁移和显式人工配置再按当前平台权限决定是否允许交接。
      environment: {
        ...structuredClone(definition.environment),
        allowIntervention: definition.environment.allowIntervention ?? false,
      },
      budget: structuredClone(definition.budget),
      executionMode: 'llm',
      evidenceKinds: [...definition.acceptanceCriteria[0]!.evidenceKinds],
    };
    // 所有新运行都使用临时会话，不能继续绑定旧登录槽节点。
    delete profile.environment.auth;
    delete profile.environment.reuseAuth;
    if (
      replacement?.mode === 'manual' ||
      replacement?.mode === 'auto' ||
      (!replacement && usesLocalIdentity(definition.sessionPlan))
    )
      profile.environment.allowIntervention =
        this.profile?.environment.allowIntervention ?? true;
    // 新运行独立编译配置，跳过同 case 的提交幂等分支，业务定义保持原身份。
    const input = structuredClone(definition.caseV2Definition!);
    // 默认重跑重新判断身份；沿用业务核验与已指定的外部账号范围，不恢复旧本地账号或登录槽。
    const requirements = definition.sessionPlan?.automatic
      ? (input.session?.requirements ?? [])
      : (definition.sessionPlan?.requirements ??
        input.session?.requirements ??
        []);
    const external =
      definition.sessionPlan?.external?.selector ?? input.session?.external;
    if (replacement) input.session = structuredClone(replacement);
    else if (
      input.session?.mode !== 'guest' &&
      (input.session || requirements.length || external)
    )
      input.session = {
        mode: 'auto',
        ...(requirements.length
          ? { requirements: structuredClone(requirements) }
          : {}),
        ...(external ? { external: structuredClone(external) } : {}),
      };
    const result = compileCase(input, validateCaseProfile(profile));
    if (replacement) result.rerunSession = structuredClone(replacement);
    result.taskId = taskId;
    if (budgetMode === 'original') {
      result.budget = structuredClone(definition.budget);
      if (definition.stepBudget)
        result.stepBudget = structuredClone(definition.stepBudget);
      else delete result.stepBudget;
    }
    if (time) extendRerunTimeBudget(result, time);
    refreshExternalSessionBudget(result);
    return result;
  }

  /** 单 case 仍走同一原子入队端口；请求重跑先准备所有定义再统一入队。 */
  async rerun(
    id: string,
    runId: unknown,
    budgetMode: 'current' | 'original' = 'current',
    timeBudget?: unknown,
    session?: unknown,
  ): Promise<CaseResultV2> {
    const definition = await this.prepareRerun(
      id,
      runId,
      budgetMode,
      timeBudget,
      undefined,
      session,
    );
    await this.tasks.submitCaseBatch([definition]);
    return this.get(id, definition.taskId);
  }

  /** 即使 worker 异常退出，已持久化的步骤结果仍可查询。 */
  async get(id: string, runId?: string): Promise<CaseResultV2> {
    const task = await this.stored(id, runId);
    const primary = await this.project(id, task);
    if (!task.definition.comparison) return primary;
    const arms = await Promise.all(
      caseArmIds(task.definition).map(async (taskId) => {
        const arm =
          taskId === task.definition.taskId
            ? task
            : await this.tasks.task(taskId);
        return {
          ...(taskId === task.definition.taskId
            ? primary
            : await this.project(id, arm)),
          taskId,
          executionMode: arm.definition.comparison!.arm,
        };
      }),
    );
    const humanOutcome = arms.find(
      (arm) => arm.executionOutcome?.category === 'HUMAN_UNEXECUTABLE',
    )?.executionOutcome;
    return {
      ...primary,
      // 人工无法执行属于整例结果；已完成组的原始验收与证据仍保留在各组中。
      ...(humanOutcome ? { executionOutcome: humanOutcome } : {}),
      comparison: {
        id: task.definition.comparison.id,
        arms: [arms[0]!, arms[1]!],
      },
    };
  }

  /** 每组保留独立生命周期、步骤和清理；顶层沿用主组，不合并相互矛盾的结论。 */
  private async project(
    id: string,
    task: Awaited<ReturnType<TaskReader['task']>>,
  ): Promise<Omit<CaseResultV2, 'comparison'>> {
    const cleanup = await this.tasks.caseCleanup(task.definition.taskId);
    return projectCase(id, task, cleanup, this.publicUrl);
  }

  /** 取消同任务业务与收尾；历史独立清理仍按旧调度规则处理。 */
  async cancel(id: string): Promise<CaseResultV2> {
    const task = await this.stored(id);
    for (const taskId of caseArmIds(task.definition))
      await this.tasks.cancel(taskId);
    return this.get(id);
  }

  /** 只接受已持久化报告或步骤记录实际引用的证据身份。 */
  async requireEvidence(
    id: string,
    artifactId: string,
    runId?: string,
  ): Promise<void> {
    const task = await this.stored(id, runId);
    for (const taskId of caseArmIds(task.definition)) {
      const arm =
        taskId === task.definition.taskId
          ? task
          : await this.tasks.task(taskId);
      const cleanup = await this.tasks.caseCleanup(taskId);
      if (
        arm.report?.artifacts.some((a) => a.id === artifactId) ||
        cleanup?.report?.artifacts.some((a) => a.id === artifactId) ||
        arm.stepResults?.some(
          (step) =>
            step.evidenceRefs.includes(artifactId) ||
            step.criteria.some((c) => c.evidenceRefs.includes(artifactId)),
        )
      )
        return;
    }
    throw new ApiError(
      404,
      'EVIDENCE_MISSING',
      '该证据不属于本 case 的已交付结果',
    );
  }
}
