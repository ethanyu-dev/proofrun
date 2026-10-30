import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  access,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceFingerprint } from '../../scripts/benchmarks/source.mjs';
import {
  verifyReleaseCI,
  prepareReleaseSource,
} from '../../scripts/railway-release-source.mjs';
import {
  REAL_BENCHMARK_CASES,
  REAL_BENCHMARK_SUITE,
} from '../../contracts/dist/benchmark.js';

/** 只模拟已结束的 CI 元数据，不能作为真实 GitHub 检查通过的凭据。 */
const repository = 'fixture/proofrun';
const commit = 'a'.repeat(40);
const ci = {
  id: 123,
  run_attempt: 2,
  repository: { full_name: repository },
  head_repository: { full_name: repository },
  head_sha: commit,
  head_branch: 'main',
  event: 'push',
  path: '.github/workflows/ci.yml',
  status: 'completed',
  conclusion: 'success',
};
// 范围：CI 来源围栏；不调用 GitHub，不把 PR 或独立基准成功当成完整发布资格。
test('只接受同仓库当前 main 的完整成功 CI', () => {
  assert.doesNotThrow(() => verifyReleaseCI(ci, repository, commit));
  for (const change of [
    { conclusion: 'failure' },
    { status: 'in_progress' },
    { event: 'pull_request' },
    { head_branch: 'feature' },
    { head_sha: 'b'.repeat(40) },
    { head_repository: { full_name: 'other/repo' } },
    { path: '.github/workflows/real-agent-benchmark.yml' },
  ])
    assert.throws(
      () => verifyReleaseCI({ ...ci, ...change }, repository, commit),
      /发布被阻止/,
    );
});
// 范围：真实 Git 归档和原门禁读取；报告为显式夹具，不运行模型、Chrome 或 Railway 部署。
test('干净发布包带入同提交 CI 报告，拒绝缺失、错配、过期与未通过报告', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'proofrun-release-test-'));
  const root = join(temporary, 'repo');
  await mkdir(root);
  let prepared;
  try {
    for (const name of [
      '.github',
      'apps',
      'packages',
      'contracts',
      'crates',
      'scripts',
      'tests',
      'deploy',
    ]) {
      await mkdir(join(root, name));
      await writeFile(join(root, name, '.keep'), 'fixture');
    }
    for (const name of [
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'Cargo.toml',
      'Cargo.lock',
      'rust-toolchain.toml',
      'tsconfig.base.json',
    ])
      await writeFile(join(root, name), 'fixture');
    const git = (args) =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    git(['init', '-q']);
    git(['add', '.']);
    git([
      '-c',
      'user.name=fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-qm',
      'fixture',
    ]);
    const sha = git(['rev-parse', 'HEAD']);
    await writeFile(join(root, '.env'), 'DO_NOT_UPLOAD');
    const fingerprint = await sourceFingerprint(root);
    const now = new Date().toISOString();
    const model = {
      id: 'call',
      callIndex: 1,
      decisionIndex: 1,
      model: 'fixture',
      purpose: 'DECISION',
      startedAt: now,
      finishedAt: now,
      status: 'RECEIVED',
      request: JSON.stringify({
        messages: [
          {
            role: 'user',
            content: JSON.stringify({
              task: {},
              state: {},
              page: {},
              history: [],
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
                { function: { name: 'verification_finish', arguments: '{}' } },
              ],
            },
          },
        ],
      }),
      requestSha256: fingerprint,
      error: null,
      promptTokens: 1,
      completionTokens: 1,
      elapsedMs: 1,
      imagesOmitted: 0,
      archived: false,
    };
    const report = {
      schemaVersion: 2,
      id: 'fixture-run',
      suite: REAL_BENCHMARK_SUITE,
      mode: 'real',
      origin: 'ci',
      createdAt: now,
      completedAt: now,
      release: {
        version: 'ci-fixture',
        buildId: 'ci-123-2',
        commit: sha,
        sourceFingerprint: fingerprint,
        kind: 'release',
      },
      source: { revision: sha, fingerprint, dirty: false },
      environment: { node: 'fixture', platform: 'fixture', arch: 'fixture' },
      config: { model: 'fixture', maxTurns: 12, maxContextChars: 12000 },
      runtime: {
        ready: true,
        engineVersion: 'agent-browser 0.38.1',
        chromeVersion: 'fixture',
        hostSha256: fingerprint,
        engineSha256: fingerprint,
      },
      modelConfiguration: {
        vision: false,
        tokenParameter: 'max_tokens',
        maxTokens: 10,
        thinking: 'default',
        reasoningEffort: 'default',
        endpointFingerprint: fingerprint,
        modelMs: 1000,
      },
      cases: REAL_BENCHMARK_CASES.map((id) => ({
        id,
        name: id,
        scope: '显式协议夹具，不代表真实模型或浏览器验收',
        elapsedMs: 1,
        verdict: 'PASSED',
        checks: [{ name: 'fixture', passed: true, detail: 'fixture' }],
        calls: [structuredClone(model)],
        commands: [],
        facts: { visits: 1, writes: [], sessionClosed: true, injected: false },
      })),
    };
    const path = join(temporary, 'real.json');
    const options = {
      root,
      ci: { ...ci, head_sha: sha },
      repository,
      commit: sha,
      report: path,
    };
    await assert.rejects(prepareReleaseSource(options), /ENOENT/);
    await writeFile(path, JSON.stringify(report));
    prepared = await prepareReleaseSource(options);
    assert.equal(await sourceFingerprint(prepared.directory), fingerprint);
    assert.deepEqual(
      JSON.parse(
        await readFile(
          join(prepared.directory, '.benchmark-release/real.json'),
          'utf8',
        ),
      ),
      report,
    );
    await assert.rejects(access(join(prepared.directory, '.env')));
    await assert.rejects(access(join(prepared.directory, '.git')));
    // 同一 CI 只重跑其他失败作业时，已通过的较早真实报告仍受相同提交、指纹和有效期校验。
    const earlier = structuredClone(report);
    earlier.release.buildId = 'ci-123-1';
    await writeFile(path, JSON.stringify(earlier));
    const resumed = await prepareReleaseSource(options);
    await rm(resumed.temporary, { recursive: true, force: true });
    for (const mutate of [
      (run) => {
        run.release.buildId = 'ci-123-3';
      },
      (run) => {
        run.release.buildId = 'ci-other';
      },
      (run) => {
        run.release.commit = 'c'.repeat(40);
      },
      (run) => {
        run.source.fingerprint = 'd'.repeat(64);
        run.release.sourceFingerprint = run.source.fingerprint;
      },
      (run) => {
        run.createdAt = new Date(
          Date.now() - 25 * 60 * 60 * 1000,
        ).toISOString();
      },
      (run) => {
        run.cases[0].checks[0].passed = false;
      },
      (run) => {
        run.origin = 'local';
      },
    ]) {
      const changed = structuredClone(report);
      mutate(changed);
      await writeFile(path, JSON.stringify(changed));
      await assert.rejects(prepareReleaseSource(options), /发布被阻止/);
    }
  } finally {
    if (prepared)
      await rm(prepared.temporary, { recursive: true, force: true });
    await rm(temporary, { recursive: true, force: true });
  }
});

// 范围：平台和 HTTP 均为内存夹具，验证备份、忙任务围栏及发布顺序；不会修改 Railway 或发送通知。
test('顺序发布共用已校验目录，任何前置或 API 部署失败都停止后续服务', async () => {
  const { releaseRailway } = await import('../../scripts/railway-release.mjs');
  for (const failure of [null, 'gate', 'busy', 'api']) {
    const temporary = await mkdtemp(join(tmpdir(), 'proofrun-release-flow-'));
    const actions = [];
    const backups = new Set();
    let uploads = 0;
    const run = async (binary, args) => {
      if (binary === 'git') return commit;
      if (binary === 'gh')
        return args[0] === 'run'
          ? ''
          : JSON.stringify(
              args[1].includes('/actions/runs/') ? ci : { sha: commit },
            );
      assert.equal(binary, 'railway');
      actions.push(args);
      if (args[0] === 'variable')
        return JSON.stringify({
          PROOFRUN_PUBLIC_URL: 'https://fixture.test',
          PROOFRUN_ADMIN_TOKEN: 'fixture-token',
        });
      if (args[0] === 'api') {
        const input = JSON.parse(args[3]);
        if (args[1].includes('environments'))
          return JSON.stringify({
            data: {
              project: {
                environments: {
                  edges: [
                    {
                      node: {
                        id: 'env',
                        name: 'production',
                        volumeInstances: {
                          edges: ['api', 'Postgres'].map((name) => ({
                            node: {
                              id: name,
                              service: { name },
                              deletedAt: null,
                            },
                          })),
                        },
                      },
                    },
                  ],
                },
              },
            },
          });
        if (args[1].includes('volumeInstanceBackupCreate')) {
          backups.add(input.id);
          return JSON.stringify({
            data: { volumeInstanceBackupCreate: { workflowId: 'fixture' } },
          });
        }
        return JSON.stringify({
          data: {
            volumeInstanceBackupList: backups.has(input.id)
              ? [{ name: 'ci-123-2', id: input.id }]
              : [],
          },
        });
      }
      if (args[0] === 'up') {
        assert.equal(backups.size, 2);
        uploads++;
        return JSON.stringify({ deploymentId: `deployment-${uploads}` });
      }
      if (args[0] === 'deployment')
        return JSON.stringify([
          {
            id: `deployment-${uploads}`,
            status: failure === 'api' ? 'FAILED' : 'SUCCESS',
          },
        ]);
      throw new Error('意外命令');
    };
    try {
      const action = releaseRailway(
        { repository, runId: '123', project: 'project', environment: 'env' },
        {
          run,
          prepare: async () => {
            if (failure === 'gate') throw new Error('发布被阻止：夹具报告失败');
            return {
              temporary,
              directory: join(temporary, 'source'),
              release: { version: 'fixture' },
            };
          },
          fetchJson: async (url) => ({
            ok: true,
            json: async () =>
              url.pathname === '/v1/tasks'
                ? { tasks: failure === 'busy' ? [{}] : [], nextCursor: null }
                : url.pathname.endsWith('/status')
                  ? { release: { commit } }
                  : { commit },
          }),
        },
      );
      if (failure) await assert.rejects(action, /发布被阻止|部署未成功/);
      else await action;
      const uploads = actions.filter((args) => args[0] === 'up');
      assert.deepEqual(
        uploads.map((args) => args[args.indexOf('--service') + 1]),
        failure === 'api' ? ['api'] : failure ? [] : ['api', 'agent', 'web'],
      );
      assert(
        uploads.every(
          (args) =>
            args[1] === join(temporary, 'source') &&
            args.includes('--no-gitignore') &&
            args.includes('--path-as-root'),
        ),
      );
      if (['gate', 'busy'].includes(failure)) assert.equal(backups.size, 0);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
});
