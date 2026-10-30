import { readFileSync } from 'node:fs';
import { isReleaseIdentity, type ReleaseIdentity } from './release.js';

/** 只读取当前应用旁的构建清单，不能用运行时环境变量覆盖已部署代码的版本。 */
export function deployedRelease(path: URL): ReleaseIdentity {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isReleaseIdentity(value)) throw new Error('构建版本清单无效');
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return {
      version: 'development',
      buildId: 'unversioned',
      commit: null,
      sourceFingerprint: null,
      kind: 'development',
    };
  }
}
