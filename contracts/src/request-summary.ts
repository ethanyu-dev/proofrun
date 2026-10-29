import type { RequestResultV2 } from './generated/request-result-v2.js';
import type { RequestSummary } from './generated/request-summary.js';
import type { VerificationTask } from './generated/verification-task.js';

/** 汇总版本随判定语义变更；不依赖客户端时钟或模型生成结论。 */
const AGGREGATION_VERSION = 1;
/** 排队与运行均未结束；其余任务状态保持原协议含义。 */
const ACTIVE_STATES = new Set(['QUEUED', 'RUNNING']);
type Member = RequestResultV2['cases'][number];
type Verdict = NonNullable<Member['reportStatus']>;

/** 调用方只传入业务标准，清理标准在读取冻结定义时排除。 */
export interface RequestCaseFacts {
  /** 与其他 case 隔离标准身份的全局 case 身份。 */
  caseId: string;
  /** 来源定义的目标说明，不由汇总生成。 */
  title: string;
  /** 来源是接收时冻结的事实，不因查询或重提改变。 */
  executionOrigin: 'created' | 'reused';
  /** 整请求重跑的成员来源，普通提交为空。 */
  sourceCaseId: string | null;
  /** 验收标准按身份去重，不能按执行次数增加总数。 */
  criteria: VerificationTask['acceptanceCriteria'];
  /** 冻结步骤用于展示准备与清理；列表汇总可省略。 */
  steps?: Member['steps'];
  /** 只包含该 case 当前关联的一次执行。 */
  arms: Member['arms'];
}

/** 失败优先；缺失报告不生成虚假的单组结论。 */
function combine(statuses: (Verdict | null)[]): Verdict {
  if (statuses.includes('FAILED')) return 'FAILED';
  return statuses.length > 0 && statuses.every((s) => s === 'PASSED')
    ? 'PASSED'
    : 'INCONCLUSIVE';
}

/** 对齐原始验收身份与证据；重复记录与单组汇总保持同一保守口径。 */
export function summarizeRequestCase(facts: RequestCaseFacts): Member {
  const arm = facts.arms[0];
  if (facts.arms.length !== 1 || !arm)
    throw new Error('每个 case 必须关联一次执行');
  const finished = !ACTIVE_STATES.has(arm.result.status);
  const criteria: Member['criteria'] = [
    ...new Map(facts.criteria.map((c) => [c.id, c])).values(),
  ].map((criterion) => {
    const records =
      arm.result.result?.criteria.filter(
        (c) => c.criterionId === criterion.id,
      ) ?? [];
    const verdict = !arm.result.result
      ? null
      : records.some((c) => c.verdict === 'FAILED')
        ? ('FAILED' as const)
        : records.length > 1
          ? ('INCONCLUSIVE' as const)
          : (records[0]?.verdict ?? ('SKIPPED' as const));
    const reading = {
      taskId: arm.taskId,
      executionMode: arm.executionMode,
      verdict,
      summary: records.map((c) => c.summary).join('\n'),
      evidenceRefs: [...new Set(records.flatMap((c) => c.evidenceRefs))],
    };

    const status =
      verdict === 'FAILED'
        ? ('FAILED' as const)
        : !finished
          ? ('PENDING' as const)
          : verdict === 'PASSED'
            ? ('PASSED' as const)
            : verdict === null || verdict === 'SKIPPED'
              ? ('SKIPPED' as const)
              : ('INCONCLUSIVE' as const);
    return {
      criterionId: criterion.id,
      stepId: criterion.stepId ?? '',
      description: criterion.description,
      expectedResult: criterion.expectedResult,
      status,
      arms: [reading],
    };
  });
  return {
    caseId: facts.caseId,
    title: facts.title,
    executionOrigin: facts.executionOrigin,
    sourceCaseId: facts.sourceCaseId,
    finished,
    reportStatus: finished ? (arm.result.reportStatus ?? 'INCONCLUSIVE') : null,
    criteria,
    steps: facts.steps ?? [],
    arms: facts.arms,
  };
}

/** 读取方提供同一数据库快照的成员；函数不访问数据库或合并不同读取时刻。 */
export function summarizeRequest(
  cases: Member[],
): Omit<
  RequestSummary,
  'requestId' | 'title' | 'createdAt' | 'sourceRequestId' | 'generatedAt'
> {
  const arms = cases.flatMap((c) => c.arms);
  const executionCounts = {
    total: arms.length,
    queued: 0,
    running: 0,
    completed: 0,
    cancelled: 0,
    timedOut: 0,
    error: 0,
  };
  const keys = {
    QUEUED: 'queued',
    RUNNING: 'running',
    COMPLETED: 'completed',
    CANCELLED: 'cancelled',
    TIMED_OUT: 'timedOut',
    ERROR: 'error',
  } as const;
  for (const arm of arms) executionCounts[keys[arm.result.status]]++;
  const finished = cases.every((c) => c.finished);
  const available = arms.filter((a) => a.result.result !== null).length;
  const criteria = cases.flatMap((c) => c.criteria);
  const uniqueCriteriaCounts = {
    total: criteria.length,
    passed: 0,
    failed: 0,
    inconclusive: 0,
    skipped: 0,
    pending: 0,
  };
  const criterionKeys = {
    PASSED: 'passed',
    FAILED: 'failed',
    INCONCLUSIVE: 'inconclusive',
    SKIPPED: 'skipped',
    PENDING: 'pending',
  } as const;
  for (const c of criteria) uniqueCriteriaCounts[criterionKeys[c.status]]++;
  const criteriaCounts = {
    total: 0,
    passed: 0,
    failed: 0,
    inconclusive: 0,
    skipped: 0,
  };
  for (const arm of arms)
    if (arm.result.criteriaCounts)
      for (const key of Object.keys(
        criteriaCounts,
      ) as (keyof typeof criteriaCounts)[])
        criteriaCounts[key] += arm.result.criteriaCounts[key];
  return {
    aggregationVersion: AGGREGATION_VERSION,
    caseCount: cases.length,
    finishedCaseCount: cases.filter((c) => c.finished).length,
    executionStatus: finished
      ? 'FINISHED'
      : executionCounts.queued === arms.length
        ? 'QUEUED'
        : 'IN_PROGRESS',
    executionCounts,
    reportPhase: finished ? 'FINAL' : available ? 'PARTIAL' : 'PENDING',
    reportStatus: finished ? combine(cases.map((c) => c.reportStatus)) : null,
    reportCoverage: {
      expected: arms.length,
      available,
      missing: arms.length - available,
    },
    observedFailureCount: uniqueCriteriaCounts.failed,
    uniqueCriteriaCounts,
    byExecutionMode: [
      {
        executionMode: 'llm',
        caseCount: arms.length,
        missingReportCount: arms.length - available,
        criteriaCounts,
      },
    ],
  };
}
