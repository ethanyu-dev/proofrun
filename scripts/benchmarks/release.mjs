import { execFileSync } from 'node:child_process';
import { isReleaseIdentity } from '../../contracts/dist/release.js';
import { ROOT, sourceFingerprint } from './source.mjs';

/** 本地没有显式版本时记录开发身份；CI/发布命令必须显式提供版本，不能把包版本当成发布版本。 */
export async function releaseIdentity(version, required = false) {
  let commit = process.env.GITHUB_SHA ?? null;
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {}
  const fingerprint = await sourceFingerprint();
  const requested = version || process.env.PROOFRUN_RELEASE_VERSION;
  if (required && !requested)
    throw new Error(
      '发布基准必须传 --version <发布版本> 或 PROOFRUN_RELEASE_VERSION',
    );
  const release = {
    version: requested ?? `dev-${fingerprint.slice(0, 12)}`,
    buildId:
      process.env.PROOFRUN_BUILD_ID ??
      (process.env.GITHUB_RUN_ID
        ? `ci-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT ?? '1'}`
        : `local-${fingerprint.slice(0, 16)}`),
    commit,
    sourceFingerprint: fingerprint,
    kind: requested ? 'release' : 'development',
  };
  if (!isReleaseIdentity(release)) throw new Error('发布版本或构建身份无效');
  return release;
}
