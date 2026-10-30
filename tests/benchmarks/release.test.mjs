import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { deployedRelease } from '../../contracts/dist/deployment.js';
import { releaseIdentity } from '../../scripts/benchmarks/release.mjs';

// 范围：发布身份读取和预检失败的候选废弃；构造的清单不是实际镜像部署证明，不调用模型。
test('构建清单不接受运行时覆盖，缺少版本的新发布尝试废弃旧候选', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'proofrun-release-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'build-info.json');
  assert.equal(deployedRelease(pathToFileURL(path)).kind, 'development');
  const release = await releaseIdentity('v0.3.0-test');
  await writeFile(path, JSON.stringify(release));
  assert.deepEqual(deployedRelease(pathToFileURL(path)), release);
  await writeFile(path, JSON.stringify({ ...release, version: '../bad' }));
  assert.throws(() => deployedRelease(pathToFileURL(path)), /清单无效/);
  const candidate = join(root, 'real.json');
  await writeFile(candidate, JSON.stringify({ previous: 'candidate' }));
  const env = { ...process.env };
  delete env.PROOFRUN_RELEASE_VERSION;
  const result = spawnSync(
    process.execPath,
    ['scripts/benchmarks/real-agent-loop.mjs', '--release-report', candidate],
    { env, encoding: 'utf8', timeout: 30000 },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /发布基准必须传/);
  const { readFile } = await import('node:fs/promises');
  assert.equal(
    JSON.parse(await readFile(candidate, 'utf8')).previous,
    undefined,
  );
});
