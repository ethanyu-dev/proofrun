import type { VerificationReport, VerificationTask } from '@proofrun/contracts';
import { AgentFault } from '../http.js';

type Criterion = VerificationReport['criteria'][number];

/** 当前步骤的逐项验收账本；结论通过证据校验后保留，后续异常只补未验收项目。 */
export class CriteriaLedger {
  /** 键为原标准身份，只写入已经核实证据归属的声明。 */
  private readonly records = new Map<string, Criterion>();

  constructor(
    private readonly expected: VerificationTask['acceptanceCriteria'],
  ) {}

  /** 整批先校验再提交，重复登记不算进展，已登记结论不可降级或改写。 */
  record(
    criteria: Criterion[],
    evidence: Map<string, VerificationReport['artifacts'][number]>,
  ): boolean {
    const seen = new Set<string>();
    for (const actual of criteria) {
      const source = this.expected.find((c) => c.id === actual.criterionId);
      if (!source || seen.has(actual.criterionId)) throw this.invalid();
      seen.add(actual.criterionId);
      if (actual.evidenceRefs.some((id) => !evidence.has(id)))
        throw this.invalid('引用了未登记的证据');
      if (
        ['PASSED', 'FAILED'].includes(actual.verdict) &&
        source.evidenceKinds.some(
          (kind) =>
            !actual.evidenceRefs.some((id) => evidence.get(id)?.kind === kind),
        )
      )
        throw this.invalid('缺少该验收项要求的证据类型');
      const previous = this.records.get(actual.criterionId);
      if (previous && previous.verdict !== actual.verdict)
        throw this.invalid('已保存的结论不可覆盖，请只提交未登记的验收项');
    }
    let changed = false;
    for (const actual of criteria) {
      if (!this.records.has(actual.criterionId)) {
        this.records.set(actual.criterionId, structuredClone(actual));
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
        ? `${reason}。合法 criterionId：${this.expected.map((c) => c.id).join('、')}；只提交未登记项目，引用已提供的 evidenceRefs。`
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
