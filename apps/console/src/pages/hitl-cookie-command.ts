import type { NodeCommand } from '@proofrun/contracts';

/** 组合队列最多八项，预留最后一次刷新；全部写完前不触发页面请求。 */
export const COOKIE_LIMIT = 7;
/** 与节点 Cookie 协议一致；拒绝整段 Cookie 请求头及分号等分隔符。 */
const COOKIE_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const COOKIE_VALUE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/;

/** 属性由处理者按原 Cookie 填写；敏感值只存于当前表单内存。 */
export interface CookieEntry {
  /** Cookie 键名，不接受 key=value 整段文本。 */
  name: string;
  /** 原始值，不自动编码、解码或裁剪。 */
  value: string;
  /** 必须匹配原站点设置，避免脚本无法读取所需登录信息。 */
  httpOnly: boolean;
}

/** 本地拒绝格式错误，避免无效 Cookie 消息导致处理连接关闭；错误不包含敏感值。 */
export function cookieCommands(
  url: string,
  entries: CookieEntry[],
  refresh: boolean,
): NodeCommand['command'][] {
  const target = new URL(url);
  if (
    !['https:', 'http:'].includes(target.protocol) ||
    target.username ||
    target.password ||
    url.length > 2048
  )
    throw new Error('任务站点地址无效，无法写入 Cookie');
  if (!entries.length || entries.length > COOKIE_LIMIT)
    throw new Error(`一次请填写 1–${COOKIE_LIMIT} 项 Cookie`);
  const names = new Set<string>();
  const commands: NodeCommand['command'][] = entries.map((entry, index) => {
    if (!COOKIE_NAME.test(entry.name) || entry.name.length > 256)
      throw new Error(
        `第 ${index + 1} 项名称格式有误，请只填写 key，不含等号或空格`,
      );
    if (
      !entry.value ||
      entry.value.length > 4096 ||
      !COOKIE_VALUE.test(entry.value)
    )
      throw new Error(
        `第 ${index + 1} 项值格式有误，请只填写 value，不含引号、分号、空格或换行`,
      );
    if (names.has(entry.name))
      throw new Error('Cookie 名称重复，请合并后再提交');
    names.add(entry.name);
    return {
      type: 'browser.cookies.set',
      url,
      name: entry.name,
      value: entry.value,
      httpOnly: entry.httpOnly,
    };
  });
  if (refresh) commands.push({ type: 'browser.act', action: 'reload' });
  return commands;
}
