import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { isReleaseIdentity } from '../../contracts/dist/release.js';
import { ROOT, sourceFingerprint } from './source.mjs';

/** CI 在镜像外校验真实报告后提取的版本清单；普通源码构建不需要此文件。 */
const RELEASE_INFO = '.benchmark-release/build-info.json';
/** 只接受完整提交，避免把分支名或短 SHA 当作可追溯的构建身份。 */
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;

/** 版本由构建时固定；源码摘要始终重新计算，不读取真实报告或运行时变量。 */
export async function buildIdentity({ root = ROOT, commit = '' } = {}) {
  const fingerprint = await sourceFingerprint(root);
  let metadata;
  try {
    metadata = await readFile(resolve(root, RELEASE_INFO), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  // 上传的 CI 归档可能没有平台 Git 信息，以已校验且与源码匹配的清单为准。
  if (metadata !== undefined) {
    const identity = JSON.parse(metadata);
    if (
      !isReleaseIdentity(identity) ||
      identity.sourceFingerprint !== fingerprint
    )
      throw new Error('构建版本清单无效或与当前源码不匹配');
    return identity;
  }
  if (commit && !COMMIT_PATTERN.test(commit))
    throw new Error('构建提交必须为完整的 40 位小写 Git SHA');
  return {
    version: commit ? `git-${commit.slice(0, 12)}` : 'development',
    // 同一份源码在 API、Agent、Web 中共享身份；配置重建不制造代码版本漂移。
    buildId: `source-${fingerprint}`,
    commit: commit || null,
    sourceFingerprint: fingerprint,
    kind: commit ? 'release' : 'development',
  };
}

/** CLI 只在构建阶段接收平台提供的提交；应用启动后仍只读取镜像内的清单。 */
async function main() {
  const { values } = parseArgs({ options: { output: { type: 'string' } } });
  if (!values.output) throw new Error('需要 --output 构建清单路径');
  const identity = await buildIdentity({
    commit: process.env.RAILWAY_GIT_COMMIT_SHA ?? '',
  });
  await writeFile(values.output, JSON.stringify(identity, null, 2) + '\n');
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
