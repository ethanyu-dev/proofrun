import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realSite } from './real-site.mjs';
import {
  realCases,
  realGrant,
  verifyRealCase,
  REAL_LIMITS,
} from './real-cases.mjs';
import {
  parseBenchmark,
  benchmarkReleaseIssues,
  benchmarkReleaseReady,
  REAL_BENCHMARK_SUITE,
  REAL_BENCHMARK_CASES,
  V2_BENCHMARK_SUITE,
  BENCHMARK_MAX_BYTES,
} from '../../contracts/dist/benchmark.js';
import { verifyRelease } from '../../scripts/benchmarks/release-gate.mjs';

// 范围：实际 HTTP 服务独立记录重复写入和隔离场景，不启动模型/浏览器，不能作为真实发布证明。
test('合成站点真值按实际请求计数，不由模型报告决定', async (t) => {
  const site = await realSite();
  t.after(() => site.close());
  const page = await fetch(`${site.origin}/form-submit`);
  assert.equal(page.status, 200);
  for (let i = 0; i < 2; i++) {
    const result = await fetch(`${site.origin}/form-submit/save`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Alice', city: 'Hangzhou' }),
    });
    assert.equal((await result.json()).count, i + 1);
  }
  assert.equal(site.facts('form-submit').writes.length, 2);
  assert.equal(site.facts('form-submit').visits, 1);
  assert.deepEqual(site.facts('read-only').writes, []);
  const facts = site.facts('form-submit');
  facts.writes.length = 0;
  assert.equal(site.facts('form-submit').writes.length, 2);
  assert.equal((await fetch(`${site.origin}/admin`)).status, 404);
});

// 范围：用明确构造的归档验证发布审核拒绝路径，不把这些合成字段视作真实浏览器/模型验收。
test('发布门禁拒绝脚本、不完整、过期、失败和源码变化', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'proofrun-gate-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = spawnSync(
    process.execPath,
    ['scripts/benchmarks/agent-loop.mjs', '--output', directory],
    { encoding: 'utf8', timeout: 30000 },
  );
  assert.equal(result.status, 0, result.stderr);
  const file = (await readdir(directory)).find((entry) =>
    entry.endsWith('.json'),
  );
  const scripted = parseBenchmark(
    await readFile(join(directory, file), 'utf8'),
  );
  const digest = 'a'.repeat(64),
    now = Date.now();
  assert.throws(() => verifyRelease(scripted, digest), /真实模型/);
  const real = {
    ...scripted,
    mode: 'real',
    release: {
      version: 'v1.0.0',
      buildId: 'test-build',
      commit: 'a'.repeat(40),
      sourceFingerprint: digest,
      kind: 'release',
    },
    suite: REAL_BENCHMARK_SUITE,
    createdAt: new Date(now - 1000).toISOString(),
    completedAt: new Date(now).toISOString(),
    source: { ...scripted.source, fingerprint: digest },
    runtime: {
      ready: true,
      engineVersion: 'agent-browser 0.38.1',
      chromeVersion: 'synthetic-test',
      hostSha256: digest,
      engineSha256: digest,
    },
    modelConfiguration: {
      vision: false,
      tokenParameter: 'max_tokens',
      maxTokens: 10,
      thinking: 'default',
      reasoningEffort: 'default',
      endpointFingerprint: digest,
      modelMs: 1000,
    },
    cases: REAL_BENCHMARK_CASES.map((id, index) => ({
      ...structuredClone(scripted.cases[index % scripted.cases.length]),
      id,
      facts: { visits: 1, writes: [], sessionClosed: true, injected: false },
    })),
  };
  // 范围：复现多步骤大归档的读取边界；只扩大 V2 存储体积，不改变基础套件预算或发布规则。
  const large = structuredClone(real);
  large.cases[0].scope = 'x'.repeat(BENCHMARK_MAX_BYTES);
  assert.throws(() => parseBenchmark(JSON.stringify(large)), /20 MiB/);
  large.suite = V2_BENCHMARK_SUITE;
  for (const item of large.cases)
    item.verification = {
      sourceTaskId: 'fixture',
      sourceCreatedAt: large.createdAt,
      sourceDefinitionSha256: digest,
      historicalVerdict: 'INCONCLUSIVE',
      task: {},
      steps: [],
      report: null,
      sessionClosed: false,
    };
  assert.equal(parseBenchmark(JSON.stringify(large)).suite, V2_BENCHMARK_SUITE);
  assert.throws(() => verifyRelease(large, digest, now));
  large.cases[0].verification.steps = [
    { stepId: 'step-1', status: 'COMPLETED', summary: {} },
  ];
  assert.throws(() => parseBenchmark(JSON.stringify(large)), /summary/);
  const valid = parseBenchmark(JSON.stringify(real));
  assert.equal(verifyRelease(valid, digest, now), valid);
  assert.deepEqual(benchmarkReleaseIssues(valid), []);
  const development = structuredClone(valid);
  development.release.kind = 'development';
  assert.equal(benchmarkReleaseReady(development), false);
  assert.equal(benchmarkReleaseIssues(development).length, 1);
  assert.match(benchmarkReleaseIssues(development)[0], /未指定发布版本/);

  for (const mutate of [
    (run) => {
      run.cases[0].verification = {};
    },
    (run) => {
      run.suite = 'agent-loop-real-v3';
    },
    (run) => {
      run.cases = run.cases.slice(0, 10);
    },
    (run) => {
      run.release.commit = null;
    },
    (run) => {
      run.schemaVersion = 1;
      delete run.release;
      delete run.origin;
    },
    (run) => {
      run.release.kind = 'development';
    },
    (run) => {
      run.release.sourceFingerprint = 'b'.repeat(64);
    },
    (run) => {
      run.completedAt = null;
    },
    (run) => {
      run.cases.pop();
    },
    (run) => {
      run.runtime.ready = false;
    },
    (run) => {
      run.cases[0].facts.sessionClosed = false;
    },
    (run) => {
      run.cases[0].checks[0].passed = false;
    },
    (run) => {
      run.cases[0].calls[0].request = null;
    },
    (run) => {
      run.source.fingerprint = 'b'.repeat(64);
    },
    (run) => {
      run.createdAt = new Date(now - 25 * 3600000).toISOString();
    },
    (run) => {
      run.completedAt = new Date(now + 120000).toISOString();
    },
  ]) {
    const changed = structuredClone(valid);
    mutate(changed);
    assert.throws(() => verifyRelease(changed, digest, now));
  }
});

// 范围：确认发布集合与通用任务类型一致，并用错误交付夹具验证拒绝路径；不替代真实模型和浏览器运行。
test('新增浏览器任务保留预算，空验收不能冒充任务完成', () => {
  assert.deepEqual(
    realCases.map((c) => c.id),
    [...REAL_BENCHMARK_CASES],
  );
  assert.deepEqual(REAL_LIMITS, {
    maxTurns: 12,
    maxContextChars: 12000,
    timeoutMs: 180000,
    maxActions: 10,
  });
  for (const scenario of realCases.filter((c) => c.id.startsWith('browser-'))) {
    const { task } = realGrant(scenario, 'http://127.0.0.1:12345');
    assert.equal(task.taskKind, 'browser');
    assert.deepEqual(task.acceptanceCriteria, []);
    assert.equal(task.budget.timeoutMs, 180000);
    assert.throws(() =>
      verifyRealCase(
        scenario,
        { commands: [] },
        { verdict: 'PASSED' },
        { visits: 1, writes: [] },
      ),
    );
    assert.throws(() =>
      verifyRealCase(
        scenario,
        { commands: [] },
        {
          verdict: null,
          executionDisposition: 'EXECUTED',
          browserResult: {
            outcome: 'COMPLETED',
            output: '已完成',
            evidenceRefs: ['fixture'],
          },
        },
        { visits: 1, writes: [] },
      ),
    );
  }
});

// 范围：只验证页面路由和真实 HTTP 账本，浏览器选择、跨标签和展开行为由真实基准单独验收。
test('新增页面提供独立目标且选择控件写入按实际请求保留', async (t) => {
  const site = await realSite();
  t.after(() => site.close());
  for (const id of [
    'browser-controls',
    'browser-tabs',
    'browser-disclosures',
  ]) {
    assert.equal((await fetch(`${site.origin}/${id}`)).status, 200);
    assert.equal(site.facts(id).visits, 1);
    assert.deepEqual(site.facts(id).writes, []);
  }
  const value = { name: 'Alice', city: 'Hangzhou', consent: 'on' };
  await fetch(`${site.origin}/browser-controls/save`, {
    method: 'POST',
    body: JSON.stringify(value),
  });
  assert.deepEqual(site.facts('browser-controls').writes, [value]);
  assert.deepEqual(site.facts('browser-tabs').writes, []);
});

// 范围：回执夹具验证隐藏面板不能靠正文泄露或重复点击冒充展开；不代表真实浏览器验收。
test('展开场景要求两个独立可见面板，正文含编号不足以通过', () => {
  const scenario = realCases.find((c) => c.id === 'browser-disclosures');
  const text = 'BASIC-17 19 PRO-29 49';
  const last = {
    text,
    targets: [
      { disclosure: { expanded: true, visible: true, text: 'BASIC-17 19' } },
      { disclosure: { expanded: false, visible: false, text: 'PRO-29 49' } },
    ],
  };
  const control = {
    commands: [
      {
        operation: { type: 'browser.act', action: 'click' },
        status: 'SUCCEEDED',
      },
      {
        operation: { type: 'browser.act', action: 'click' },
        status: 'SUCCEEDED',
      },
      {
        operation: { type: 'browser.observe' },
        status: 'SUCCEEDED',
        result: last,
      },
    ],
  };
  const report = {
    verdict: null,
    executionDisposition: 'EXECUTED',
    browserResult: {
      outcome: 'COMPLETED',
      output: text,
      evidenceRefs: ['fixture'],
    },
  };
  const facts = { visits: 1, writes: [] };
  assert.throws(
    () => verifyRealCase(scenario, control, report, facts),
    /真实展开/,
  );
  last.targets[1].disclosure.expanded = true;
  last.targets[1].disclosure.visible = true;
  assert.doesNotThrow(() => verifyRealCase(scenario, control, report, facts));
});

// 范围：网络场景真实 HTTP 响应与独立验收拒绝伪通过；未启动 Chrome，不冒充网络采集验收。
test('网络场景响应头来自服务端，缺少实际视图切换不能通过', async (t) => {
  const site = await realSite();
  t.after(() => site.close());
  for (const id of ['network-runtime', 'network-page-return']) {
    const scenario = realCases.find((item) => item.id === id);
    assert.equal((await fetch(`${site.origin}/${id}`)).status, 200);
    const response = await fetch(`${site.origin}/${id}/resource`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'max-age=73');
    const task = realGrant(scenario, site.origin).task;
    assert(task.acceptanceCriteria[0].evidenceKinds.includes('NETWORK'));
    assert.throws(
      () =>
        verifyRealCase(
          scenario,
          { calls: new Map(), commands: [] },
          { verdict: 'PASSED' },
          site.facts(id),
        ),
      /网络专用/,
    );
  }
});

// 范围：真实 HTTP 页面可达与独立判定器拒绝伪交付、逆序及重复写入；浏览器行为由完整真实基准另行验证。
test('基础交互必须观察中间状态再完成，不能用模型正文替代实际操作', async (t) => {
  const site = await realSite();
  t.after(() => site.close());
  for (const id of ['browser-validation', 'browser-search']) {
    const scenario = realCases.find((c) => c.id === id);
    assert.equal((await fetch(`${site.origin}/${id}`)).status, 200);
    const validation = id === 'browser-validation';
    const before = validation ? '请填写城市；尚未保存' : '没有匹配结果';
    const after = validation
      ? '已保存：Alice / Hangzhou；保存次数 1'
      : '条目编号 BOOK-42；库存 7 件';
    if (validation)
      await fetch(`${site.origin}/${id}/save`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Alice', city: 'Hangzhou' }),
      });
    const control = {
      commands: [before, after].map((text) => ({
        operation: { type: 'browser.observe' },
        status: 'SUCCEEDED',
        result: { text },
      })),
    };
    const report = {
      verdict: null,
      executionDisposition: 'EXECUTED',
      browserResult: {
        outcome: 'COMPLETED',
        output: `${before}；${after}`,
        evidenceRefs: ['fixture'],
      },
    };
    const facts = site.facts(id);
    assert.doesNotThrow(() => verifyRealCase(scenario, control, report, facts));
    assert.throws(
      () =>
        verifyRealCase(
          scenario,
          { commands: control.commands.slice(1) },
          report,
          facts,
        ),
      /有序观察/,
    );
    assert.throws(
      () =>
        verifyRealCase(
          scenario,
          { commands: [...control.commands].reverse() },
          report,
          facts,
        ),
      /有序观察/,
    );
    assert.throws(
      () =>
        verifyRealCase(
          scenario,
          control,
          {
            ...report,
            browserResult: { ...report.browserResult, output: '已完成' },
          },
          facts,
        ),
      /实际交付/,
    );
    assert.throws(
      () =>
        verifyRealCase(scenario, control, report, {
          ...facts,
          writes: [...facts.writes, { name: 'Alice', city: 'Hangzhou' }],
        }),
      /副作用/,
    );
  }
});
