import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  validateControlRequest,
  type ControlRequest,
  type NodeCommand,
  type NodeEvent,
} from '@proofrun/contracts';

/** 文件和协议身份只允许安全字符；不将任意用户输入直接作为存储路径。 */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
/** PostgreSQL bigint 转为 JSON number 时必须保留精度。 */
export const MAX_FENCE = Number.MAX_SAFE_INTEGER;
/** 单条节点消息的传输上限，与 Rust 节点保持一致。 */
export const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
export type Heartbeat = Extract<NodeEvent, { type: 'node.heartbeat' }>;
export type CommandResult = Extract<NodeEvent, { type: 'command.result' }>;
export type BrowserOperation = Extract<
  NodeCommand['command'],
  {
    type:
      | 'browser.observe'
      | 'browser.act'
      | 'browser.wait'
      | 'browser.auth.save'
      | 'browser.input'
      | 'browser.trace';
  }
>;

/** 对外可识别的领域拒绝，不用错误文本驱动重试。 */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** 保留稳定键顺序，跨请求比较相同逻辑输入，不能依赖 JSON 对象原始排列。 */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
/** 摘要同时用于凭据存储、幂等比较和证据校验。 */
export function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
/** 不记录明文令牌；只有签发响应和节点私有凭据文件持有它。 */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}
/** 检查固定角色的 Bearer 凭据，避免比较过程泄漏前缀信息。 */
export function requireToken(
  header: string | undefined,
  expected: string,
): void {
  const supplied = bearer(header);
  if (
    !timingSafeEqual(
      Buffer.from(digest(supplied)),
      Buffer.from(digest(expected)),
    )
  )
    throw new ApiError(401, 'UNAUTHORIZED', 'Invalid credential');
}
/** 提取凭据；不接受 URL 查询参数传递密钥。 */
export function bearer(header: string | undefined): string {
  if (!header?.startsWith('Bearer ') || header.length > 512)
    throw new ApiError(401, 'UNAUTHORIZED', 'Bearer credential required');
  return header.slice(7);
}
/** 结构校验来自公共 Schema，具体角色和执行归属由调用方继续验证。 */
export function parseRequest<T extends ControlRequest['type']>(
  value: unknown,
  type: T,
): Extract<ControlRequest, { type: T }> {
  if (!validateControlRequest(value) || value.type !== type)
    throw new ApiError(
      400,
      'INVALID_REQUEST',
      'Request does not match the control protocol',
    );
  return value as Extract<ControlRequest, { type: T }>;
}
