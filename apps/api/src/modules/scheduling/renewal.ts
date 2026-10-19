import type { CommandResult } from '../../domain.js';

/** 迟到续期只拒绝本条授权；节点仍用本地时钟撤销真正过期的会话，不能复活租约。 */
export function staleRenewal(kind: string, result: CommandResult): boolean {
  return (
    kind === 'session.renew' &&
    result.effect === 'NOT_STARTED' &&
    ['LEASE_EXPIRED', 'DEADLINE_EXCEEDED'].includes(result.error?.code ?? '')
  );
}
