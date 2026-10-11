/** localStorage 按当前站点隔离；仅保存管理员连接凭据，不保存人工处理链接令牌。 */
const CREDENTIAL_KEY = 'proofrun.console.credential';
/** 主动断开后保留表单记忆，但跨刷新暂停自动连接；旧版本凭据默认允许恢复。 */
const RESTORE_DISABLED_KEY = 'proofrun.console.restore-disabled';

/** 存储受限时仍可手动连接；读取异常不得阻止连接页渲染。 */
export function readSavedCredential(): string {
  try {
    return localStorage.getItem(CREDENTIAL_KEY) ?? '';
  } catch {
    return '';
  }
}

/** 仅为自动恢复读取凭据；存储受限或主动断开时回退到手动连接。 */
export function readRestorableCredential(): string {
  try {
    return localStorage.getItem(RESTORE_DISABLED_KEY) === 'true'
      ? ''
      : readSavedCredential().trim();
  } catch {
    return '';
  }
}

/** 不删除表单中的凭据记忆；返回失败时由调用方提示无法持久化断开状态。 */
export function suspendCredentialRestore(): boolean {
  try {
    localStorage.setItem(RESTORE_DISABLED_KEY, 'true');
    return true;
  } catch {
    return false;
  }
}

/** 仅在控制面验证成功后调用；返回值用于提示本地保存是否成功。 */
export function saveCredential(token: string): boolean {
  try {
    localStorage.setItem(CREDENTIAL_KEY, token);
    localStorage.removeItem(RESTORE_DISABLED_KEY);
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
