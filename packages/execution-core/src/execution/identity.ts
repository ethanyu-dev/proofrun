import type { IdentityCheck, StepResult } from '@proofrun/contracts';
import type { Observation } from '../evidence/observation.js';

/** 前置结果来自观察或人工控制代次；不接受模型对角色的自由推断。 */
export type CheckResult = NonNullable<StepResult['preconditions']>[number];
/** 只携带同一执行内已完成准备步骤的人工事实；不把旧 DOM 或旧认证状态升级成当前事实。 */
export function sessionIdentityFacts(
  setupResults: StepResult[],
  current: CheckResult[],
  controlRevision: number,
  authRevision?: number,
): CheckResult[] {
  const currentIds = new Set(current.map((check) => check.id));
  const facts = new Map<string, CheckResult>();
  for (const step of setupResults) {
    for (const check of step.preconditions ?? []) {
      if (currentIds.has(check.id)) continue;
      // 新的同名结果无论是否满足都覆盖早期事实，防止撤销后的确认被复活。
      facts.delete(check.id);
      if (
        step.status === 'COMPLETED' &&
        check.source === 'human' &&
        check.status === 'SATISFIED' &&
        (authRevision === undefined
          ? check.controlRevision === controlRevision
          : check.authRevision === authRevision)
      )
        facts.set(check.id, structuredClone(check));
    }
  }
  return [...facts.values()];
}
/** 身份条件与步骤条件合并后保持稳定顺序，同 ID 只能表示同一条件。 */
export function mergeChecks(...groups: IdentityCheck[][]): IdentityCheck[] {
  const checks = new Map<string, IdentityCheck>();
  for (const check of groups.flat()) {
    const previous = checks.get(check.id);
    if (
      previous &&
      (previous.method !== check.method ||
        previous.description !== check.description ||
        previous.value !== check.value)
    )
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
  authRevision?: number,
): CheckResult[] {
  return checks.map((check) => {
    const manual = check.method === 'manual';
    const confirmed = human.get(check.id) === (authRevision ?? revision);
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
      ...(manual && confirmed
        ? {
            controlRevision: revision,
            ...(authRevision !== undefined ? { authRevision } : {}),
          }
        : {}),
    };
  });
}
