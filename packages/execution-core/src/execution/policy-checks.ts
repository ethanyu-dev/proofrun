import { createHash } from 'node:crypto';
import type { CaseStep, StepResult } from '@proofrun/contracts';
import type { Observation } from '../evidence/observation.js';

/** 检查结果只表示固定条件的事实，不替代业务 expected 的验收。 */
export type PolicyResult = NonNullable<StepResult['preconditions']>[number] & {
  /** 关联原始 policy 的位置，同一 policy 可以要求多个事实同时成立。 */
  policyIndex: number;
  /** 区分未采集、范围未知、明确失败和没有观察到，不能把缺失当失败。 */
  reason: string;
};

/** 稳定身份绑定作用域及不可变定义，文案或条件变化不能沿用旧确认。 */
export function conditionKey(scope: string, definition: unknown): string {
  return createHash('sha256')
    .update(
      JSON.stringify([scope, definition], (_key, value) =>
        value && typeof value === 'object' && !Array.isArray(value)
          ? Object.fromEntries(
              Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
            )
          : value,
      ),
    )
    .digest('hex');
}

/** 网络只采信当前 tab 和导航；DOM 条件固定为完整正文包含，不能由模型降低标准。 */
export function evaluatePolicyChecks(
  step: CaseStep,
  observation: Observation,
): PolicyResult[] {
  return (step.policyChecks ?? []).map((check) => {
    let status: PolicyResult['status'] = 'UNCONFIRMED';
    let reason = 'EVIDENCE_NOT_OBSERVED';
    if (check.method === 'renderedContent') {
      if (
        observation.text.trim() &&
        !observation.truncated &&
        (observation.coverage?.text as { truncated?: boolean })?.truncated !==
          true
      ) {
        status = observation.text.includes(check.text!)
          ? 'SATISFIED'
          : 'UNSATISFIED';
        reason =
          status === 'SATISFIED'
            ? 'RENDERED_CONTENT_OBSERVED'
            : 'RENDERED_CONTENT_MISSING';
      }
    } else {
      const network = observation.network as
        | {
            scope?: string;
            navigationId?: string;
            requests?: Array<{
              url?: string;
              status?: number;
              navigationId?: string;
            }>;
          }
        | undefined;
      if (!network) reason = 'EVIDENCE_NOT_COLLECTED';
      else if (network.scope !== 'tab-navigation' || !network.navigationId)
        reason = 'EVIDENCE_SCOPE_UNAVAILABLE';
      else {
        const responses = (network.requests ?? []).filter((request) => {
          try {
            const url = new URL(request.url!);
            return (
              url.origin === new URL(step.url).origin &&
              new URL(observation.url).origin === url.origin &&
              url.pathname === check.path &&
              request.navigationId === network.navigationId &&
              typeof request.status === 'number'
            );
          } catch {
            return false;
          }
        });
        if (
          responses.some(
            (response) =>
              response.status! >= check.statusMin! &&
              response.status! <= check.statusMax!,
          )
        ) {
          status = 'SATISFIED';
          reason = 'NETWORK_RESPONSE_OBSERVED';
        } else if (responses.length) {
          status = 'UNSATISFIED';
          reason = 'NETWORK_STATUS_MISMATCH';
        }
      }
    }
    if (
      !observation.artifactRefs.some(
        (ref) =>
          ref.kind === (check.method === 'networkResponse' ? 'NETWORK' : 'DOM'),
      )
    ) {
      status = 'UNCONFIRMED';
      reason = 'EVIDENCE_NOT_COLLECTED';
    }
    return {
      id: `policy-${conditionKey(step.stepId ?? '', check).slice(0, 32)}`,
      description: check.description,
      policyIndex: check.policyIndex,
      status,
      reason,
      source: 'observation',
      evidenceRefs: observation.artifactRefs
        .filter(
          (ref) =>
            ref.kind ===
            (check.method === 'networkResponse' ? 'NETWORK' : 'DOM'),
        )
        .map((ref) => ref.artifactId),
    };
  });
}
