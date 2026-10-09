import type { NodeCommand } from '@proofrun/contracts';
import { ApiError } from '../../domain.js';

/** 独立处理页只开放当前会话的网页导航和刷新；不扩展为任意 browser.act 代理。 */
export function validateHitlNavigation(
  command: Extract<NodeCommand['command'], { type: 'browser.act' }>,
): void {
  // 丢弃多余参数会改变命令身份，因此直接拒绝，保留原命令去重语义。
  const keys =
    command.action === 'navigate'
      ? ['type', 'action', 'target']
      : ['type', 'action'];
  const shape = Object.keys(command).every((key) => keys.includes(key));
  if (shape && command.action === 'reload') return;
  if (shape && command.action === 'navigate' && command.target) {
    try {
      const url = new URL(command.target);
      if (
        ['http:', 'https:'].includes(url.protocol) &&
        !url.username &&
        !url.password
      )
        return;
    } catch {
      /* 无效地址与非网页协议使用同一明确错误。 */
    }
  }
  throw new ApiError(
    400,
    'HITL_NAVIGATION',
    '只允许刷新或前往不含账号密码的 HTTP/HTTPS 网页',
  );
}
