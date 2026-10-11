import type { IdentityCheck, StepResult } from '@proofrun/contracts';
import type { Observation } from '../evidence/observation.js';

/** 前置结果来自观察或人工控制代次；不接受模型对角色的自由推断。 */
export type CheckResult = NonNullable<StepResult['preconditions']>[number];
/** 身份条件与步骤条件合并后保持稳定顺序，同 ID 只能表示同一条件。 */
export function mergeChecks(...groups: IdentityCheck[][]): IdentityCheck[] {
  const checks = new Map<string, IdentityCheck>();
  for (const check of groups.flat()) {
    const previous = checks.get(check.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(check))
      throw new Error('前置条件 ID 冲突');
    checks.set(check.id, check);
  }
  return [...checks.values()];
}

/** 缺失或裁剪观察不能用于证明“不存在”；人工证明绑定当前控制代次。 */
export function evaluateChecks(
  checks: IdentityCheck[],
  observation: Observation,
  human: ReadonlyMap<string, number>,
  revision: number,
): CheckResult[] {
  return checks.map((check) => {
    const manual = check.method === 'manual';
    const confirmed = human.get(check.id) === revision;
    const text = observation.text;
    const complete =
      !observation.truncated &&
      (observation.coverage?.text as { truncated?: boolean } | undefined)
        ?.truncated !== true &&
      !!text.trim();
    const satisfied = manual
      ? confirmed
      : check.method === 'text'
        ? text.includes(check.value!)
        : complete && !text.includes(check.value!);
    return {
      id: check.id,
      description: check.description,
      status: satisfied
        ? 'SATISFIED'
        : manual || !complete
          ? 'UNCONFIRMED'
          : 'UNSATISFIED',
      source: manual ? 'human' : 'observation',
      evidenceRefs: manual
        ? []
        : observation.artifactRefs.map((ref) => ref.artifactId),
      ...(manual && confirmed ? { controlRevision: revision } : {}),
    };
  });
}
