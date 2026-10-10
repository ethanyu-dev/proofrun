import {
  summarizeReport,
  validateVerificationCaseV2,
  type CaseResultV2,
  type StepResult,
  type VerificationReport,
  type VerificationTask,
} from '@proofrun/contracts';
import { ApiError, canonical } from '../../domain.js';
import type { Coordinator } from '../scheduling/coordinator.js';
import { validateCaseProfile, type CaseProfile } from './profile.js';
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
    private readonly tasks: Pick<
      Coordinator,
      'submitCaseBatch' | 'task' | 'cancel' | 'caseCleanup'
    >,
    /** 首次接收使用的平台配置；幂等重提使用已冻结快照。 */
    private readonly profile: CaseProfile | undefined,
    /** 构造同源公开证据地址，不透传内部报告地址。 */
    private readonly publicUrl: string,
  ) {}

  /** 身份不是任意内部任务路径；清理结果也只通过所属 case 读取。 */
  private async stored(id: string) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id))
      throw new ApiError(404, 'CASE_MISSING', 'Case not found');
    const task = await this.tasks
      .task(`${V2_PREFIX}${id}`)
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.code === 'TASK_MISSING')
          throw new ApiError(404, 'CASE_MISSING', 'Case not found');
        throw error;
      });
    if (task.definition.caseV2Definition?.caseId !== id)
      throw new ApiError(404, 'CASE_MISSING', 'Case not found');
    return task;
  }

  /** 报告只映射公开结果；证据链接仍需验证主任务或关联清理任务归属。 */
  private result(
    id: string,
    report: VerificationReport | null,
  ): CaseResultV2['result'] {
    return report
      ? {
          outcome:
            report.executionDisposition === 'EXECUTED'
              ? report.verdict!
              : report.executionDisposition,
          summary: report.summary,
          criteria: report.criteria,
          evidence: report.artifacts.map((a) => ({
            id: a.id,
            kind: a.kind,
            sha256: a.sha256,
            url: `${this.publicUrl}/v2/cases/${encodeURIComponent(id)}/evidence/${encodeURIComponent(a.id)}`,
          })),
        }
      : null;
  }

  /** 先校验整批，再由调度器事务接收；配置改变后重提仍复用首次冻结的快照。 */
  async submit(input: unknown): Promise<CaseResultV2[]> {
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
        definitions.push(compileCase(item, validateCaseProfile(this.profile)));
      }
    }
    await this.tasks.submitCaseBatch(definitions);
    return Promise.all(input.map((item) => this.get(item.caseId)));
  }

  /** 重跑从主组冻结配置恢复整个 case；新身份重新编译收尾，不复制执行状态或报告。 */
  async rerun(id: string, caseId: unknown): Promise<CaseResultV2> {
    if (
      typeof caseId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,80}$/.test(caseId) ||
      caseId === id
    )
      throw new ApiError(400, 'INVALID_RERUN', '重跑需要一个新的有效 caseId');
    const { definition } = await this.stored(id);
    const profile: CaseProfile = {
      environment: structuredClone(definition.environment),
      budget: structuredClone(definition.budget),
      executionMode: definition.comparison
        ? 'parallel'
        : (definition.executionMode ?? 'llm'),
      evidenceKinds: [...definition.acceptanceCriteria[0]!.evidenceKinds],
    };
    // 复用提交的幂等检查与原子拆组；重试使用目标已冻结的配置，不产生额外任务。
    const service = new CaseV2Service(this.tasks, profile, this.publicUrl);
    const [result] = await service.submit([
      { ...structuredClone(definition.caseV2Definition!), caseId },
    ]);
    return result!;
  }

  /** 即使 worker 异常退出，已持久化的步骤结果仍可查询。 */
  async get(id: string): Promise<CaseResultV2> {
    const task = await this.stored(id);
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
    return {
      ...primary,
      comparison: {
        id: task.definition.comparison.id,
        arms: [arms[0]!, arms[1]!],
      },
    };
  }

  /** 每组保留独立生命周期、步骤和清理；顶层沿用主组，不合并相互矛盾的结论。 */
  private async project(
    id: string,
    task: Awaited<ReturnType<Coordinator['task']>>,
  ): Promise<Omit<CaseResultV2, 'comparison'>> {
    const cleanup = await this.tasks.caseCleanup(task.definition.taskId);
    const pending: StepResult[] = task.definition.steps!.map((step) => ({
      stepId: step.stepId!,
      status: ['QUEUED', 'RUNNING'].includes(task.state)
        ? 'PENDING'
        : 'SKIPPED',
      summary: '尚未执行',
      evidenceRefs: [],
      criteria: [],
      startedAt: null,
      finishedAt: null,
    }));
    const steps = structuredClone(
      task.report?.steps ?? task.stepResults ?? pending,
    );
    if (!['QUEUED', 'RUNNING'].includes(task.state) && !task.report) {
      for (const step of steps) {
        if (step.status === 'RUNNING') {
          step.status = 'ERROR';
          step.summary = '执行已终止，未交付该步骤完成结论';
        } else if (step.status === 'PENDING') {
          step.status = 'SKIPPED';
          step.summary = '任务已终止，未执行';
        }
      }
    }
    return {
      caseId: id,
      status: task.state,
      queueReason: task.queueReason ?? null,
      ...summarizeReport(
        task.report,
        task.definition.acceptanceCriteria.map((c) => c.id),
        task.definition,
      ),
      result: this.result(id, task.report),
      steps,
      cleanup: cleanup
        ? {
            taskId: cleanup.taskId,
            status: cleanup.status,
            result: this.result(id, cleanup.report),
          }
        : null,
    };
  }

  /** 取消同任务业务与收尾；历史独立清理仍按旧调度规则处理。 */
  async cancel(id: string): Promise<CaseResultV2> {
    const task = await this.stored(id);
    for (const taskId of caseArmIds(task.definition))
      await this.tasks.cancel(taskId);
    return this.get(id);
  }

  /** 只接受已持久化报告或步骤记录实际引用的证据身份。 */
  async requireEvidence(id: string, artifactId: string): Promise<void> {
    const task = await this.stored(id);
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
