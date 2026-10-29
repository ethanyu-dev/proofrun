import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { parseBenchmark } from '../../contracts/dist/benchmark.js';
import { verifyRelease } from './release-gate.mjs';
import { sourceFingerprint } from './source.mjs';

/** 最终镜像只嵌入经过审核的发布身份，不能在启动时通过变量伪造版本。 */
const { values } = parseArgs({ options: { output: { type: 'string' } } });
if (!values.output) throw new Error('需要 --output 构建清单路径');
const run = verifyRelease(
  parseBenchmark(await readFile('.benchmark-release/real.json', 'utf8')),
  await sourceFingerprint(),
);
await writeFile(values.output, JSON.stringify(run.release, null, 2) + '\n');
