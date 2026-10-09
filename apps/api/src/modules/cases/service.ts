import {
  summarizeReport,
  validateVerificationCase,
  type CaseResult,
  type VerificationTask,
} from '@proofrun/contracts';
import { ApiError, canonical } from '../../domain.js';
import type { Coordinator } from '../scheduling/coordinator.js';
import {
  caseBudget,
  validateCaseProfile,
  type CaseProfile,
} from './profile.js';

/** 独立命名空间使公开 case 不会误读普通内部任务。 */
const CASE_PREFIX = 'case-';
/** 公开身份限制为安全字符，且为内部前缀保留长度空间。 */
const CASE_ID = /^[A-Za-z0-9_-]{1,100}$/;
/** 步骤中的换行归一化，确保内部步骤识别不会把一条业务步骤拆成多条。 */
const STEP_BREAKS = /[\r\n]+/gu;
/** 适配层只依赖已有任务端口，便于验证持久化和业务投影的职责边界。 */
type CaseTasks = Pick<Coordinator, 'submit' | 'task' | 'cancel'>;
/** 内部完整记录只在服务端流转，返回前转换为 CaseResult。 */
type StoredTask = Awaited<ReturnType<Coordinator['task']>>;

/** 将业务 case 适配为既有任务；执行、幂等锁和报告校验仍归原控制面管理。 */
export class CaseService {
  constructor(
    /** 只使用任务端口，不建立第二个执行循环。 */
    private readonly tasks: CaseTasks,
    /** 平台配置只影响新 case；重提使用首次保存的配置。 */
    private readonly profile: CaseProfile | undefined,
    /** 证据链接由服务端构造，不透传内部报告地址。 */
    private readonly publicUrl: string,
  ) {}

  /** 先验证公开身份，再映射到内部身份，禁止通过路径读取非 case 任务。 */
  private taskId(id: string): string {
    if (!CASE_ID.test(id))
      throw new ApiError(404, 'CASE_MISSING', 'Case not found');
    return `${CASE_PREFIX}${id}`;
  }

  /** 仅接受本入口保存的定义；旧任务和内部任务不被自动公开。 */
  private async stored(id: string): Promise<StoredTask> {
    let stored: StoredTask;
    try {
      stored = await this.tasks.task(this.taskId(id));
    } catch (error) {
      if (error instanceof ApiError && error.code === 'TASK_MISSING')
        throw new ApiError(404, 'CASE_MISSING', 'Case not found');
      throw error;
    }
    if (stored.definition.caseDefinition?.caseId !== id)
      throw new ApiError(404, 'CASE_MISSING', 'Case not found');
    return stored;
  }

  /** 显式挑选业务结果，避免环境、节点、模型调用和资源清理字段进入公开响应。 */
  private result(id: string, stored: StoredTask): CaseResult {
    const report = stored.report;
    return {
      caseId: id,
      status: stored.state,
      queueReason: stored.queueReason ?? null,
      ...summarizeReport(
        report,
        stored.definition.acceptanceCriteria.map((c) => c.id),
      ),
      result: report
        ? {
            outcome:
              report.executionDisposition === 'EXECUTED'
                ? report.verdict!
                : report.executionDisposition,
            summary: report.summary,
            criteria: report.criteria.map((c) => ({
              criterionId: c.criterionId,
              verdict: c.verdict,
              summary: c.summary,
              evidenceRefs: [...c.evidenceRefs],
            })),
            evidence: report.artifacts.map((a) => ({
              id: a.id,
              kind: a.kind,
              sha256: a.sha256,
              url: `${this.publicUrl}/v1/cases/${encodeURIComponent(id)}/evidence/${encodeURIComponent(a.id)}`,
            })),
          }
        : null,
    };
  }

  /** 原始 case 随任务在同一事务持久化；配置变化不改变已提交 case 的幂等语义。 */
  async submit(input: unknown): Promise<CaseResult> {
    if (!validateVerificationCase(input))
      throw new ApiError(
        400,
        'INVALID_CASE',
        'Case does not match VerificationCase',
      );
    const ids = input.acceptanceCriteria.map((c) => c.id);
    if (new Set(ids).size !== ids.length)
      throw new ApiError(422, 'INVALID_CASE', 'Criterion IDs must be unique');
    try {
      const existing = await this.stored(input.caseId);
      if (canonical(existing.definition.caseDefinition) !== canonical(input))
        throw new ApiError(
          409,
          'CASE_CONFLICT',
          'Case identity already binds another definition',
        );
      return this.result(input.caseId, existing);
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'CASE_MISSING')
        throw error;
    }
    if (!this.profile)
      throw new ApiError(
        503,
        'CASE_NOT_CONFIGURED',
        'Case execution is not configured',
      );
    const profile = validateCaseProfile(this.profile);
    const definition: VerificationTask = {
      protocolVersion: '0.1',
      taskId: this.taskId(input.caseId),
      objective: input.steps
        ? `${input.description}\n\n必要业务步骤：\n${input.steps.map((step, i) => `${i + 1}. ${step.replace(STEP_BREAKS, ' ')}`).join('\n')}`
        : input.description,
      environment: profile.environment,
      target: { url: input.url },
      budget: caseBudget(profile, input.steps?.length ?? 1),
      executionMode: profile.executionMode === 'jev' ? 'jev' : 'llm',
      // 输入校验已保证至少一项，映射只添加平台证据要求，不删改原验收项。
      acceptanceCriteria: input.acceptanceCriteria.map((c) => ({
        ...c,
        evidenceKinds: [...profile.evidenceKinds],
      })) as VerificationTask['acceptanceCriteria'],
      caseDefinition: structuredClone(input),
    };
    try {
      return this.result(input.caseId, await this.tasks.submit(definition));
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'TASK_CONFLICT')
        throw error;
      // 并发首次提交可能使用不同副本配置；以已经持久化的相同 case 为准。
      const existing = await this.stored(input.caseId).catch(
        (lookupError: unknown) => {
          if (
            lookupError instanceof ApiError &&
            lookupError.code === 'CASE_MISSING'
          )
            return null;
          throw lookupError;
        },
      );
      if (
        existing &&
        canonical(existing.definition.caseDefinition) === canonical(input)
      )
        return this.result(input.caseId, existing);
      throw new ApiError(
        409,
        'CASE_CONFLICT',
        'Case identity already binds another definition',
      );
    }
  }

  /** 查询只读业务投影；没有报告时不自行推导验收结论。 */
  async get(id: string): Promise<CaseResult> {
    return this.result(id, await this.stored(id));
  }

  /** 取消复用既有终止流程，不回滚业务写入，也不向上层暴露会话清理状态。 */
  async cancel(id: string): Promise<CaseResult> {
    await this.stored(id);
    return this.result(id, await this.tasks.cancel(this.taskId(id)));
  }

  /** 只允许下载本 case 已交付报告中的证据，拒绝借路径读取其他任务的文件。 */
  async requireEvidence(id: string, artifactId: string): Promise<void> {
    const stored = await this.stored(id);
    const report = stored.report;
    if (!report?.artifacts.some((a) => a.id === artifactId))
      throw new ApiError(404, 'EVIDENCE_MISSING', 'Case evidence not found');
  }
}
