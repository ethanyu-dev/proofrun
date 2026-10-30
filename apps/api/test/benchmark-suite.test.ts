import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BENCHMARK_SCENARIOS,
  DEPLOYED_BENCHMARK_SUITE,
  LEGACY_DEPLOYED_BENCHMARK_SUITE,
} from '@proofrun/contracts/benchmark-scenarios';
import { benchmarkArchive } from '../src/modules/benchmarks/archive.js';
import type { Database } from '../src/db.js';

/** 仅供归档投影测试的身份，不代表实际部署或真实模型运行。 */
const release = {
  version: 'fixture',
  buildId: 'fixture',
  kind: 'release',
  commit: 'a'.repeat(40),
  sourceFingerprint: 'b'.repeat(64),
};
// 范围：升级后旧运行按冻结的五场景结算，新套件缺少新增项必须失败；数据库与执行数据为夹具。
test('基础套件版本冻结，不能把缺失新场景的运行当作旧套件通过', async () => {
  const rows = BENCHMARK_SCENARIOS.slice(0, 5).map((s) => ({
    scenario: s.id,
    task_id: s.id,
    state: 'QUEUED',
    execution_id: null,
    api_release: null,
    agent_release: null,
    node_runtime: null,
    created_at: new Date(),
    visits: 0,
    writes: [],
    injected: false,
  }));
  const db = {
    async query(sql: string) {
      return { rows: sql.includes('SELECT b.*') ? rows : [] };
    },
  } as unknown as Database;
  const job = {
    id: 'fixture',
    family: 'browser',
    release,
    environment: 'fixture',
    created_at: new Date(),
    suite: LEGACY_DEPLOYED_BENCHMARK_SUITE,
  };
  const old = await benchmarkArchive(db, job, false);
  assert.equal(old.suite, LEGACY_DEPLOYED_BENCHMARK_SUITE);
  assert.equal(old.cases.length, 5);
  await assert.rejects(
    () =>
      benchmarkArchive(db, { ...job, suite: DEPLOYED_BENCHMARK_SUITE }, false),
    /场景缺失/,
  );
});
