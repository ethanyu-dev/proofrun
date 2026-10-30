import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  benchmarkContext,
  benchmarkTools,
  benchmarkPassed,
  benchmarkComparison,
  parseBenchmark,
} from '../../contracts/dist/benchmark.js';
import { cases } from './cases.mjs';

/** 子进程运行完整套件以验证退出码与落盘，不使用测试自身拼装的通过结果。 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CLI = join(ROOT, 'scripts/benchmarks/agent-loop.mjs');
async function invoke(directory, baseline) {
  const result = spawnSync(
    process.execPath,
    [
      CLI,
      '--version',
      'v0.2.0-test',
      '--output',
      directory,
      ...(baseline ? ['--baseline', baseline] : []),
    ],
    { cwd: ROOT, encoding: 'utf8', timeout: 30000 },
  );
  assert.equal(result.error, undefined);
  const file = (await readdir(directory)).find((name) =>
    name.endsWith('.json'),
  );
  return {
    ...result,
    run: file
      ? parseBenchmark(await readFile(join(directory, file), 'utf8'))
      : null,
    file: file ? join(directory, file) : null,
  };
}

// 范围：真实执行器、HTTP 模型适配器、完整归档与基线 CLI 退出码；模型与页面均为脚本，不证明真实供应商或浏览器验收。
test('完整基础套件通过，显式基线不兼容或指标退化时非零退出并保留材料', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'proofrun-benchmark-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await invoke(join(directory, 'first'));
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.run.schemaVersion, 2);
  assert.equal(first.run.release.version, 'v0.2.0-test');
  assert.equal(
    first.run.release.sourceFingerprint,
    first.run.source.fingerprint,
  );
  assert.deepEqual(
    first.run.cases.map((item) => item.id),
    cases.map((item) => item.id),
  );
  assert(first.run.cases.every(benchmarkPassed));
  const invalid = first.run.cases.find((item) => item.id === 'invalid-target');
  assert.equal(benchmarkTools(invalid.calls[0])[0].name, 'browser_act');
  assert.equal(
    invalid.commands.filter((command) => command.decisionIndex === 1).length,
    0,
  );
  for (const item of first.run.cases)
    for (const call of item.calls) {
      const context = benchmarkContext(call);
      assert.equal(
        context.modules.reduce(
          (sum, part) => sum + part.chars,
          context.envelope,
        ),
        context.total,
      );
      assert(context.toolsChars > 0 && context.systemChars > 0);
    }
  const same = await invoke(join(directory, 'same'), first.file);
  assert.equal(same.status, 0, same.stderr);
  assert.equal(same.run.release.version, first.run.release.version);
  assert.notEqual(same.run.id, first.run.id);
  const baseline = structuredClone(first.run);
  baseline.suite = 'other-suite';
  const changedFile = join(directory, 'changed.json');
  await writeFile(changedFile, JSON.stringify(baseline));
  const incompatible = await invoke(
    join(directory, 'incompatible'),
    changedFile,
  );
  assert.equal(incompatible.status, 1);
  assert(incompatible.run.cases.every((item) => !benchmarkPassed(item)));
  baseline.suite = first.run.suite;
  baseline.cases[0].calls = baseline.cases[0].calls.slice(0, 1);
  await writeFile(changedFile, JSON.stringify(baseline));
  const regressed = await invoke(join(directory, 'regressed'), changedFile);
  assert.equal(regressed.status, 1);
  assert(
    regressed.run.cases[0].checks.some(
      (check) => !check.passed && check.name === '显式基线回归门禁',
    ),
  );

  // 范围：导入结构校验、空结果与损坏正文不能形成通过；不验证归档签名真实性。
  await t.test('损坏归档和空结果被拒绝，缺失上下文不补造零值', () => {
    assert.throws(() => parseBenchmark('{}'));
    assert.throws(() =>
      parseBenchmark(JSON.stringify({ ...first.run, schemaVersion: 3 })),
    );
    assert.throws(() =>
      parseBenchmark(JSON.stringify({ ...first.run, cases: [] })),
    );
    assert.throws(() =>
      parseBenchmark(
        JSON.stringify({
          ...first.run,
          cases: [first.run.cases[0], first.run.cases[0]],
        }),
      ),
    );
    const damaged = structuredClone(first.run);
    damaged.cases[0].calls[0].request = '{invalid';
    assert.equal(benchmarkContext(damaged.cases[0].calls[0]), null);
    assert.equal(benchmarkPassed(damaged.cases[0]), false);
    assert.equal(
      benchmarkComparison(first.run, damaged),
      '基线包含失败或不完整场景',
    );
    damaged.cases[0].commands[0].decisionIndex = -1;
    assert.throws(() => parseBenchmark(JSON.stringify(damaged)));
  });
});
