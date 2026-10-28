import type { SessionPlan, SessionRequest } from '@proofrun/contracts';
import { ApiError } from '../../domain.js';

/** DevPass 材料准备最多两分钟，不借用业务步骤额度。 */
export const PREPARATION_MS = 120_000;

/** 历史快照仍可读取，但本地身份计划不能重新进入执行链路。 */
export function usesLocalIdentity(plan: SessionPlan | undefined): boolean {
  return (
    !!plan &&
    (!['guest', 'manual', 'external'].includes(plan.mode) ||
      plan.candidates.length > 0 ||
      !!plan.library ||
      !!plan.selection)
  );
}

/** 明确拒绝旧身份引用，不能把需要账号的任务静默降级为访客。 */
export function assertSupportedSession(plan: SessionPlan | undefined): void {
  if (usesLocalIdentity(plan))
    throw new ApiError(
      422,
      'LOCAL_IDENTITY_REMOVED',
      '本地测试身份已移除，请使用 DevPass 外部账号或当前会话人工登录',
    );
}

/** 只冻结 DevPass 选择条件或当前临时会话要求，不管理本地账号候选。 */
export function resolveSession(
  request: SessionRequest | undefined,
  entry: string,
  automatic = false,
): SessionPlan {
  const selection = request ?? { mode: 'manual' as const };
  if (
    selection.mode !== 'guest' &&
    selection.mode !== 'manual' &&
    selection.mode !== 'external'
  )
    throw new ApiError(
      422,
      'LOCAL_IDENTITY_REMOVED',
      '本地测试身份已移除，请使用 DevPass 外部账号或当前会话人工登录',
    );
  if (
    selection.mode === 'external' &&
    (!selection.external || (!automatic && !selection.requirements?.length))
  )
    throw new ApiError(
      422,
      'EXTERNAL_ACCOUNT_REQUIREMENTS',
      '外部账号必须提供明确身份核验条件',
    );
  return {
    version: 1,
    reducedMotion: selection.reducedMotion ?? true,
    mode: selection.mode,
    profileSource: selection.mode === 'manual' ? 'node-default' : 'empty',
    candidates: [],
    requirements: structuredClone(selection.requirements ?? []),
    preparationMs: PREPARATION_MS,
    ...(selection.mode === 'external'
      ? {
          external: {
            selector: structuredClone(selection.external!),
            origin: new URL(entry).origin,
            durationSeconds: 60,
          },
        }
      : {}),
  };
}
