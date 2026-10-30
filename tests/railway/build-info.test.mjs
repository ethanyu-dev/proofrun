import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIdentity } from '../../scripts/benchmarks/write-build-info.mjs';
import { isReleaseIdentity } from '../../contracts/dist/release.js';

/** 最小源码夹具覆盖摘要读取路径，不包含真实模型报告或生产凭据。 */
async function source(t) {
  const root = await mkdtemp(join(tmpdir(), 'proofrun-build-info-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of [
    '.github',
    'apps',
    'packages',
    'contracts',
    'crates',
    'scripts',
    'tests',
    'deploy',
  ])
    await mkdir(join(root, directory));
  for (const file of [
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'Cargo.toml',
    'Cargo.lock',
    'rust-toolchain.toml',
    'tsconfig.base.json',
  ])
    await writeFile(join(root, file), 'fixture');
  return root;
}

// 范围：无 Git 目录和真实报告的构建身份、源码漂移；不证明 Railway 注入或线上部署成功。
test('无报告构建保留提交和源码指纹，同一源码身份稳定', async (t) => {
  const root = await source(t);
  const commit = 'a'.repeat(40);
  const identity = await buildIdentity({ root, commit });
  assert(isReleaseIdentity(identity));
  assert.equal(identity.commit, commit);
  assert.equal(identity.kind, 'release');
  assert.equal(identity.version, `git-${commit.slice(0, 12)}`);
  assert.deepEqual(await buildIdentity({ root, commit }), identity);
  // 旧报告即使损坏也不参与镜像版本生成。
  await mkdir(join(root, '.benchmark-release'));
  await writeFile(join(root, '.benchmark-release/real.json'), 'invalid report');
  assert.deepEqual(await buildIdentity({ root, commit }), identity);
  await writeFile(join(root, 'apps/change.ts'), '// 源码变化');
  const changed = await buildIdentity({ root, commit });
  assert.notEqual(changed.sourceFingerprint, identity.sourceFingerprint);
  assert.notEqual(changed.buildId, identity.buildId);
});

// 范围：本地未知提交明确标记开发版本，坏提交不能冒充完整 SHA；不查询 Git 或平台。
test('没有提交仍生成开发清单，拒绝非法提交', async (t) => {
  const root = await source(t);
  const identity = await buildIdentity({ root });
  assert(isReleaseIdentity(identity));
  assert.equal(identity.kind, 'development');
  assert.equal(identity.commit, null);
  assert.match(identity.sourceFingerprint, /^[a-f0-9]{64}$/);
  await assert.rejects(buildIdentity({ root, commit: 'main' }), /完整/);
});

// 范围：独立版本清单的契约及源码绑定；清单是合成夹具，不表示真实基准通过。
test('CI 清单优先保留发布身份，拒绝损坏与过时清单', async (t) => {
  const root = await source(t);
  const identity = {
    ...(await buildIdentity({ root, commit: 'b'.repeat(40) })),
    version: 'v1.2.3',
    buildId: 'ci-123-1',
  };
  await mkdir(join(root, '.benchmark-release'));
  const path = join(root, '.benchmark-release/build-info.json');
  await writeFile(path, JSON.stringify(identity));
  assert.deepEqual(await buildIdentity({ root }), identity);
  await writeFile(join(root, 'apps/change.ts'), '// 源码变化');
  await assert.rejects(buildIdentity({ root }), /不匹配/);
  await writeFile(path, '{}');
  await assert.rejects(buildIdentity({ root }), /无效/);
  await writeFile(path, 'invalid json');
  await assert.rejects(buildIdentity({ root }), SyntaxError);
});
