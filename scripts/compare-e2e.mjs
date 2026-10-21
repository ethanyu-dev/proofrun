import { join, resolve } from 'node:path';
import { ID, read } from '../tests/scenarios/harness/storage.mjs';
import { compareRuns } from '../tests/scenarios/harness/summary.mjs';

/** 离线比较不访问模型或浏览器；输出保留每对样本，缺项不能被静默丢弃。 */
async function load(directory) {
  const root = resolve(directory);
  const manifest = await read(join(root, 'manifest.json'));
  if (!manifest) throw new Error('缺少运行清单');
  const samples = await Promise.all(
    manifest.samples.map(async ({ id }) => {
      if (!ID.test(id)) throw new Error('非法样本身份');
      const sample = await read(join(root, id, 'sample.json'));
      if (!sample) throw new Error('缺少计划样本');
      return sample;
    }),
  );
  return { manifest, samples };
}
if (process.argv.length !== 4)
  throw new Error(
    '用法：compare-e2e.mjs <baseline-directory> <candidate-directory>',
  );
const result = compareRuns(
  await load(process.argv[2]),
  await load(process.argv[3]),
);
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.pairs.some((p) => p.status === 'INCOMPLETE')
  ? 2
  : result.pairs.some((p) => p.status === 'REGRESSED')
    ? 1
    : 0;
