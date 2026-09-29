import { createHmac } from 'node:crypto';

/** 链接密钥可由受信任接口取回，数据库仅保留摘要；不是管理员令牌。 */
export function interventionToken(secret: string, id: string): string {
  return createHmac('sha256', secret)
    .update(`proofrun-hitl:${id}`)
    .digest('base64url');
}
