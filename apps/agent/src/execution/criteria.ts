import {
  isCriterionUpgrade,
  type VerificationReport,
  type VerificationTask,
} from '@proofrun/contracts';
import { AgentFault } from '../http.js';

type Criterion = VerificationReport['criteria'][number];

/** 当前步骤的逐项验收账本；结论通过证据校验后保留，后续异常只补未验收项目。 */
export class CriteriaLedger {
  /** 键为原标准身份，只写入已经核实证据归属的声明。 */
  private readonly records = new Map<string, Criterion>();

  constructor(
    private readonly expected: VerificationTask['acceptanceCriteria'],
  ) {}

  /** 整批先校验再提交；暂存结果仅凭新增有效证据升级，重复登记不算进展。 */
  record(
    criteria: Criterion[],
    evidence: Map<string, VerificationReport['artifacts'][number]>,
  ): boolean {
    const seen = new Set<string>();
    for (const actual of criteria) {
      const source = this.expected.find((c) => c.id === actual.criterionId);
      if (!source || seen.has(actual.criterionId)) throw this.invalid();
      seen.add(actual.criterionId);
      const unknownRefs = actual.evidenceRefs.filter((id) => !evidence.has(id));
      if (unknownRefs.length)
        throw this.invalid(
          `验收项 ${actual.criterionId} 引用了未登记附件 ${JSON.stringify(unknownRefs)}；observationId 不是附件 ID，请从 evidence 或 artifactRefs 逐字复制有效附件`,
        );
      if (
        ['PASSED', 'FAILED'].includes(actual.verdict) &&
        source.evidenceKinds.some(
          (kind) =>
            !actual.evidenceRefs.some((id) => evidence.get(id)?.kind === kind),
        )
      )
        throw this.invalid('缺少该验收项要求的证据类型');
      const previous = this.records.get(actual.criterionId);
      if (previous && previous.verdict !== actual.verdict) {
        if (!isCriterionUpgrade(previous, actual))
          throw this.invalid(
            '已确认的通过或失败不可改写；暂存结果必须引用本步骤新增有效证据才能升级为通过或失败',
          );
      }
    }
    let changed = false;
    for (const actual of criteria) {
      const previous = this.records.get(actual.criterionId);
      if (!previous || previous.verdict !== actual.verdict) {
        // 保留补证前的来源；历次声明正文可通过已存档的模型请求与回复追溯。
        this.records.set(
          actual.criterionId,
          structuredClone({
            ...actual,
            evidenceRefs: [
              ...new Set([
                ...(previous?.evidenceRefs ?? []),
                ...actual.evidenceRefs,
              ]),
            ],
          }),
        );
        changed = true;
      }
    }
    return changed;
  }

  /** 缺失项精确列出；setup 明确要求空数组，不让模型把 stepId 当作 criterionId。 */
  invalid(reason = '验收项必须属于当前步骤且不能重复'): AgentFault {
    return new AgentFault(
      'INVALID_MODEL_DECISION',
      this.expected.length
        ? `${reason}。合法 criterionId：${this.expected.map((c) => c.id).join('、')}；提交未登记项目，或用新增证据将 INCONCLUSIVE/SKIPPED 升级为 PASSED/FAILED；已确认结果同判定重送为幂等，引用已提供的 evidenceRefs。`
        : '当前 setup 没有独立验收项，criteria 必须是 []；stepId 不是 criterionId。请用 summary 和本步 evidenceRefs 提交执行结果。',
    );
  }

  /** 返回副本，外部不能修改已登记结论。 */
  values(): Criterion[] {
    return [...this.records.values()].map((c) => structuredClone(c));
  }
  /** 未登记身份用于下一轮纠错及最终完整性校验。 */
  pending(): string[] {
    return this.expected
      .filter((c) => !this.records.has(c.id))
      .map((c) => c.id);
  }

  /** 故障不推翻已验证项目，仅为尚无结论的标准生成未验收结果。 */
  complete(summary: string): Criterion[] {
    return this.expected.map((c) =>
      structuredClone(
        this.records.get(c.id) ?? {
          criterionId: c.id,
          verdict: 'SKIPPED' as const,
          summary,
          evidenceRefs: [],
        },
      ),
    );
  }
}
