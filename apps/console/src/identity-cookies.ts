/** 与身份库 API 的单账号限制一致，编辑器不产生无法保存的额外行。 */
export const MAX_IDENTITY_COOKIES = 32;

/** 行标识仅用于保持输入焦点，提交时只发送三个 Cookie 字段。 */
export interface CookieDraft {
  id: string;
  name: string;
  value: string;
  httpOnly: boolean;
}

/** 空行默认启用 HttpOnly；每次新增使用独立标识，删除中间行不会复用输入状态。 */
export function newCookieDraft(): CookieDraft {
  return { id: crypto.randomUUID(), name: '', value: '', httpOnly: true };
}

/** null 保留已有凭据，空数组显式清空；新增身份的未填写行不创建空种子。 */
export function identityCookiePayload(
  rows: CookieDraft[] | null,
  editing: boolean,
): string | undefined {
  if (rows === null) return undefined;
  if (!rows.length) return '[]';
  const filled = rows.filter((row) => row.name !== '' || row.value !== '');
  if (!filled.length) {
    if (editing) throw new Error('请填写 Cookie，或选择“清空 Cookies”。');
    return undefined;
  }
  const names = new Set<string>();
  for (const row of filled) {
    if (!row.name.trim()) throw new Error('请填写每项 Cookie 的 Name。');
    if (names.has(row.name)) throw new Error('Cookie 的 Name 不能重复。');
    names.add(row.name);
  }
  return JSON.stringify(
    filled.map(({ name, value, httpOnly }) => ({ name, value, httpOnly })),
  );
}
