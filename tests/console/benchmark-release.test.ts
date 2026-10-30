import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { BenchmarkRun } from '@proofrun/contracts/benchmark';
import {
  benchmarkReleaseStatus,
  BenchmarkReleaseConditions,
} from '../../apps/console/src/components/benchmark-release.tsx';
const require = createRequire(
  new URL('../../apps/console/package.json', import.meta.url),
);
const { createElement } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

// 范围：合成完整轮次只验证 UI 区分开发回归与发布资格，不代表真实模型或浏览器通过。
test('开发场景全过显示回归通过，同时解释缺少发布版本', () => {
  const run = {
    mode: 'real',
    schemaVersion: 2,
    completedAt: new Date().toISOString(),
    release: { kind: 'development' },
    source: { fingerprint: 'test' },
    cases: [
      {
        checks: [{ passed: true }],
        calls: [
          {
            status: 'RECEIVED',
            request: JSON.stringify({
              messages: [
                {
                  role: 'user',
                  content: JSON.stringify({
                    task: {},
                    state: {},
                    page: {},
                    history: {},
                    evidence: [],
                    budget: {},
                    feedback: [],
                  }),
                },
              ],
            }),
            response: JSON.stringify({
              choices: [
                {
                  message: {
                    tool_calls: [
                      {
                        function: {
                          name: 'verification_finish',
                          arguments: '{}',
                        },
                      },
                    ],
                  },
                },
              ],
            }),
          },
        ],
      },
    ],
  } as unknown as BenchmarkRun;
  assert.equal(benchmarkReleaseStatus(run).label, '开发回归通过');
  assert.equal(benchmarkReleaseStatus(run).passed, true);
  const html = renderToStaticMarkup(
    createElement(BenchmarkReleaseConditions, { run }),
  );
  assert.match(html, /未指定发布版本/);
  assert.match(html, /24 小时/);
  assert.match(html, /不代表最终发布检查已通过/);
  run.cases[0]!.checks[0]!.passed = false;
  assert.equal(benchmarkReleaseStatus(run).label, '开发回归未通过');
  assert.equal(benchmarkReleaseStatus(run).passed, false);
});

// 范围：V2 失败和未运行不会被展示为发布阻断；不改变其诊断结果，也不允许用 V2 代替真实基础报告。
test('V2 仅用于诊断，失败或未完成没有发布阻断项', () => {
  for (const suite of ['agent-loop-v2-live-v1', 'agent-loop-v2-deployed-v1']) {
    const run = {
      suite,
      mode: 'real',
      completedAt: null,
      cases: [],
    } as unknown as BenchmarkRun;
    for (const completedAt of [null, new Date().toISOString()]) {
      run.completedAt = completedAt;
      const status = benchmarkReleaseStatus(run);
      assert.equal(status.requiredForRelease, false);
      assert.equal(status.passed, false);
      assert.deepEqual(status.issues, []);
      const html = renderToStaticMarkup(
        createElement(BenchmarkReleaseConditions, { run }),
      );
      assert.match(html, /不参与发布门禁/);
      assert.doesNotMatch(html, /尚未满足发布条件/);
    }
  }
});
