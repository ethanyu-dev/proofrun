/** 发布身份由构建产物注入；开发和历史未知身份不能冒充正式部署。 */
export interface ReleaseIdentity {
  /** 对用户可见的发布版本，独立于提交 SHA。 */
  version: string;
  /** 一次构建的不可变身份，CI 通常使用工作流运行 ID。 */
  buildId: string;
  /** 完整源码提交；无 Git 元数据时明确为空。 */
  commit: string | null;
  /** 包含未提交内容的源码摘要；历史未知时为空。 */
  sourceFingerprint: string | null;
  /** 开发版本不能通过正式发布门禁。 */
  kind: 'development' | 'release';
}
/** 版本仅用于标识和筛选，不解释为路径、命令或 HTML。 */
export const RELEASE_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/;
/** 构建清单和 API 接收使用同一封闭校验。 */
export function isReleaseIdentity(value: unknown): value is ReleaseIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (
    Object.keys(entry).sort().join() ===
      ['buildId', 'commit', 'kind', 'sourceFingerprint', 'version']
        .sort()
        .join() &&
    typeof entry.version === 'string' &&
    RELEASE_VERSION_PATTERN.test(entry.version) &&
    typeof entry.buildId === 'string' &&
    RELEASE_VERSION_PATTERN.test(entry.buildId) &&
    (entry.commit === null ||
      (typeof entry.commit === 'string' &&
        /^[a-f0-9]{40}$/.test(entry.commit))) &&
    (entry.sourceFingerprint === null ||
      (typeof entry.sourceFingerprint === 'string' &&
        /^[a-f0-9]{64}$/.test(entry.sourceFingerprint))) &&
    ['development', 'release'].includes(String(entry.kind))
  );
}
