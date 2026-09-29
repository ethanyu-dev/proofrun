/** localStorage 按当前站点隔离；仅保存管理员连接凭据，不保存人工处理链接令牌。 */
const CREDENTIAL_KEY = 'proofrun.console.credential';

/** 存储受限时仍可手动连接；读取异常不得阻止连接页渲染。 */
export function readSavedCredential(): string {
  try {
    return localStorage.getItem(CREDENTIAL_KEY) ?? '';
  } catch {
    return '';
  }
}

/** 仅在控制面验证成功后调用；返回值用于提示本地保存是否成功。 */
export function saveCredential(token: string): boolean {
  try {
    localStorage.setItem(CREDENTIAL_KEY, token);
    return true;
  } catch {
    return false;
  }
}

/** 只移除本功能的凭据，保留浏览器中其他配置。 */
export function clearSavedCredential(): boolean {
  try {
    localStorage.removeItem(CREDENTIAL_KEY);
    return true;
  } catch {
    return false;
  }
}
