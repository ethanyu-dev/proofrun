import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  parseBenchmark,
  benchmarkReleaseReady,
} from '../../contracts/dist/benchmark.js';
import { ROOT, sourceFingerprint } from './source.mjs';

/** 发布只接受最近一天完成、与当前源码完全一致的真实套件。 */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** 纯校验便于覆盖拒绝路径；报告必须来自受信任的本地运行或当前 CI 作业。 */
export function verifyRelease(run, fingerprint, now = Date.now()) {
  if (!benchmarkReleaseReady(run))
    throw new Error(
      '发布被阻止：需要完整通过的真实模型 + Chrome 基准，脚本结果不能替代',
    );
  if (run.source.fingerprint !== fingerprint)
    throw new Error('发布被阻止：源码已变化，请重新运行真实基准');
  const started = Date.parse(run.createdAt),
    completed = Date.parse(run.completedAt);
  if (
    completed < started ||
    completed > now + 60000 ||
    now - started > MAX_AGE_MS
  )
    throw new Error('发布被阻止：真实基准报告已过期或时间无效');
  return run;
}
/** 缺报告、坏报告和检查失败均以非零状态退出，不回退到脚本模式。 */
async function main() {
  const path = resolve(ROOT, process.argv[2] ?? '.benchmark-release/real.json');
  const run = verifyRelease(
    parseBenchmark(await readFile(path, 'utf8')),
    await sourceFingerprint(),
  );
  console.log(
    `真实发布检查通过：${run.release.version} / ${run.release.buildId} · ${run.cases.length} 场景 · ${run.config.model} · ${run.id}`,
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await main().catch((error) => {
    console.error(
      error.code === 'ENOENT'
        ? '发布被阻止：缺少真实报告，请运行 pnpm benchmark:release --version <版本> --env-file .proofrun/local.env'
        : error.message,
    );
    process.exitCode = 1;
  });
