import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { buildApp } from '../src/app.js';
import { SimulatedNode, until } from './fixture.js';
import type { ApiConfig } from '../src/config.js';
import { benchmarkPorts } from '../src/modules/benchmarks/driver.js';
import { Benchmarks } from '../src/modules/benchmarks/service.js';
import type { Database } from '../src/db.js';
import type { ExecutionClient } from '@proofrun/execution-driver/execution/runner';
import type { ExecutionGrant } from '@proofrun/contracts';
import { parseBenchmark } from '@proofrun/contracts/benchmark';

/** 只用于隔离库和协议测试，不能作为正式部署版本证明。 */
const RELEASE = {
  version: 'v0.1.0-test',
  buildId: 'fixture-build',
  commit: 'a'.repeat(40),
  sourceFingerprint: 'b'.repeat(64),
  kind: 'release' as const,
};
const ADMIN = 'benchmark-admin-integration-test-only';
const WORKER = 'benchmark-worker-integration-test-only';

// 范围：真实 PostgreSQL/HTTP 的授权、原子入队、重启恢复、版本冻结与归档；节点及业务结论为夹具，不验收真实模型和浏览器。
test(
  '线上基准持久队列、版本身份与重启后的失败归档',
  { timeout: 60000 },
  async (t) => {
    assert.ok(
      process.env.PROOFRUN_TEST_DATABASE_URL,
      '需要隔离测试 PostgreSQL',
    );
    const manager = new pg.Pool({
      connectionString: process.env.PROOFRUN_TEST_DATABASE_URL,
    });
    const name = `proofrun_bench_${randomUUID().replaceAll('-', '')}`;
    await manager.query(`CREATE DATABASE ${name}`);
    const url = new URL(process.env.PROOFRUN_TEST_DATABASE_URL);
    url.pathname = `/${name}`;
    const directory = await mkdtemp(join(tmpdir(), 'proofrun-benchmark-api-'));
    const sql = new pg.Client({ connectionString: url.toString() });
    await sql.connect();
    const config: ApiConfig = {
      databaseUrl: url.toString(),
      adminToken: ADMIN,
      workerToken: WORKER,
      publicUrl: 'http://127.0.0.1',
      artifactDirectory: directory,
      host: '127.0.0.1',
      port: 0,
      workerLeaseMs: 2000,
      nodeLeaseMs: 2500,
      tickMs: 25,
      executionRuntimeVersion: 1,
      benchmarkNodePool: 'benchmark-fixture',
      benchmarkEnvironment: 'integration-only',
      buildIdentity: RELEASE,
    };
    let app = await buildApp(config, { logger: false });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as { port: number }).port;
    config.publicUrl = `http://127.0.0.1:${port}`;
    const node = new SimulatedNode(
      config.publicUrl,
      config.benchmarkNodePool!,
      1,
    );
    node.fullProfile = true;
    node.runtime = {
      version: 'node-v0.1.0-test',
      sourceCommit: 'c'.repeat(40),
      engineVersion: '0.38.1',
    };
    const request = (path: string, body?: unknown, token = ADMIN) =>
      app.inject({
        method: body === undefined ? 'GET' : 'POST',
        url: path,
        headers: { authorization: `Bearer ${token}` },
        ...(body === undefined ? {} : { payload: body as object }),
      });
    try {
      // 范围：只接受管理员和固定创建参数；提交者不能指定任意版本、网址或 shell 命令。
      await t.test('认证、固定输入和并发幂等', async () => {
        // 读取列表、版本、状态、详情和发起运行均须鉴权，不能只保护创建入口。
        for (const path of [
          '/v1/admin/benchmarks',
          '/v1/admin/benchmarks/status',
          '/v1/admin/benchmarks/versions',
          `/v1/admin/benchmarks/${randomUUID()}`,
        ]) {
          assert.equal(
            (await app.inject({ method: 'GET', url: path })).statusCode,
            401,
          );
        }
        assert.equal(
          (
            await app.inject({
              method: 'POST',
              url: '/v1/admin/benchmarks',
              payload: { id: randomUUID() },
            })
          ).statusCode,
          401,
        );

        assert.equal(
          (await request('/v1/admin/benchmarks', undefined, WORKER)).statusCode,
          401,
        );
        assert.equal(
          (
            await request('/v1/admin/benchmarks', {
              id: randomUUID(),
              version: 'forged',
            })
          ).statusCode,
          400,
        );
        const id = randomUUID();
        const responses = await Promise.all([
          request('/v1/admin/benchmarks', { id }),
          request('/v1/admin/benchmarks', { id }),
        ]);
        assert(
          responses.every((response) => response.statusCode === 202),
          responses.map((response) => response.body).join('\n'),
        );
        assert.equal(
          (await sql.query('SELECT count(*)::int AS n FROM pr_benchmark_runs'))
            .rows[0].n,
          1,
        );
        assert.equal(
          (await sql.query('SELECT count(*)::int AS n FROM pr_tasks')).rows[0]
            .n,
          5,
        );
        assert.equal(
          (await request('/v1/admin/benchmarks', { id: randomUUID() }))
            .statusCode,
          409,
        );
        const detail = await request(`/v1/admin/benchmarks/${id}`);
        assert.equal(detail.statusCode, 200, detail.body);
        const run = parseBenchmark(JSON.stringify(detail.json().run));
        assert.equal(run.release?.version, RELEASE.version);
        assert.equal(run.cases.length, 5);
        assert.equal(run.completedAt, null);
        const row = (
          await sql.query('SELECT task_id FROM pr_benchmark_cases LIMIT 1')
        ).rows[0];
        assert.equal(
          (await request(`/v1/benchmark-fixtures/${row.task_id}`)).statusCode,
          404,
        );
      });
      // 范围：冻结真实领取协议携带的组件身份与会话快照；运行节点本身仍为模拟器。
      await t.test('旧 worker 不领取基准，执行身份不能越权改写', async () => {
        await node.pair(ADMIN);
        await until(
          () => node.sessions.size,
          () => true,
        );
        const old = await request(
          '/v1/worker/claim',
          {
            type: 'worker.claim',
            workerId: 'old-worker',
            structuredSteps: true,
            stepBudgetVersion: 1,
            identityVersion: 2,
            profileTabsVersion: 1,
            executionPlanVersion: 1,
            runtimeVersion: 1,
          },
          WORKER,
        );
        assert.equal(old.json().execution, null);
        const claimed = await until(
          async () =>
            request(
              '/v1/worker/claim',
              {
                type: 'worker.claim',
                workerId: 'new-worker',
                structuredSteps: true,
                stepBudgetVersion: 1,
                identityVersion: 2,
                profileTabsVersion: 1,
                executionPlanVersion: 1,
                runtimeVersion: 1,
                benchmarkVersion: 1,
              },
              WORKER,
            ),
          (response) => !!response.json().execution,
        );
        const grant = claimed.json().execution;
        assert(grant.benchmark.runId);
        assert.equal(grant.runtimeVersion, 1);
        const body = {
          release: RELEASE,
          model: {
            name: 'fixture-model',
            vision: false,
            tokenParameter: 'max_tokens',
            maxTokens: 512,
            thinking: 'default',
            reasoningEffort: 'default',
            endpointFingerprint: 'd'.repeat(64),
            modelMs: 2000,
          },
        };
        const endpoint = `/v1/executions/${grant.id}/benchmark-build`;
        await until(
          async () =>
            (
              await sql.query('SELECT state FROM pr_tasks WHERE id=$1', [
                grant.task.taskId,
              ])
            ).rows[0].state,
          (state) => state === 'RUNNING',
        );
        const runtime = {
          type: 'start',
          config: {
            model: 'fixture-model',
            vision: false,
            commandMs: 20000,
            evidenceMs: 30000,
            maxTurns: 12,
            maxContextChars: 12000,
          },
        };
        assert.equal(
          (
            await request(
              `/v1/executions/${grant.id}/runtime`,
              runtime,
              grant.leaseToken,
            )
          ).json().code,
          'BENCHMARK_CONFIG_CONFLICT',
        );
        assert.equal((await request(endpoint, body, WORKER)).statusCode, 401);
        assert.equal(
          (await request(endpoint, body, grant.leaseToken)).statusCode,
          200,
        );
        assert.equal(
          (await request(endpoint, body, grant.leaseToken)).statusCode,
          200,
        );
        assert.equal(
          (
            await request(
              `/v1/executions/${grant.id}/runtime`,
              { ...runtime, config: { ...runtime.config, maxTurns: 50 } },
              grant.leaseToken,
            )
          ).json().code,
          'BENCHMARK_CONFIG_CONFLICT',
        );
        assert.equal(
          (
            await request(
              endpoint,
              { ...body, release: { ...RELEASE, version: 'forged' } },
              grant.leaseToken,
            )
          ).statusCode,
          409,
        );
        assert.equal(
          (
            await request(
              endpoint,
              { ...body, model: { ...body.model, apiKey: 'never-store-this' } },
              grant.leaseToken,
            )
          ).statusCode,
          400,
        );
        await until(
          async () =>
            (
              await sql.query('SELECT state FROM pr_tasks WHERE id=$1', [
                grant.task.taskId,
              ])
            ).rows[0].state,
          (state) => state === 'RUNNING',
        );
        const first = await request(
          `/v1/benchmark-fixtures/${grant.task.taskId}`,
        );
        assert.equal(first.statusCode, 200, first.body);
        for (let i = 0; i < 2; i++)
          assert.equal(
            (
              await request(
                `/v1/benchmark-fixtures/${grant.task.taskId}/save`,
                { name: 'Alice', city: 'Hangzhou' },
              )
            ).json().count,
            i + 1,
          );
        // 模型正文为合成协议记录，只验证逐轮原文及配置能贯穿数据库与导出，不冒充真实供应商调用。
        const call = {
          id: randomUUID(),
          callIndex: 1,
          decisionIndex: 1,
          model: 'fixture-model',
          purpose: 'DECISION',
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          status: 'RECEIVED',
          request: JSON.stringify({
            messages: [
              {
                role: 'user',
                content: JSON.stringify({
                  task: {},
                  state: {},
                  page: { text: 'synthetic' },
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
          requestSha256: 'e'.repeat(64),
          error: null,
          promptTokens: 10,
          completionTokens: 4,
          elapsedMs: 1,
          imagesOmitted: 0,
          archived: false,
        };
        await sql.query(
          'INSERT INTO pr_model_calls(id,execution_id,call_index,record,start_hash) VALUES($1,$2,1,$3,$4)',
          [call.id, grant.id, call, 'fixture'],
        );
        const detail = (
          await request(`/v1/admin/benchmarks/${grant.benchmark.runId}`)
        ).json();
        const archived = parseBenchmark(JSON.stringify(detail.run)).cases.find(
          (item) => item.id === grant.benchmark.caseId,
        )!;
        assert.deepEqual(archived.calls[0], call);
        assert.equal(
          archived.modelConfiguration?.endpointFingerprint,
          body.model.endpointFingerprint,
        );
        assert.equal(detail.run.deploymentEnvironment, 'integration-only');
        const row = (
          await sql.query(
            'SELECT node_runtime FROM pr_sessions WHERE execution_id=$1',
            [grant.id],
          )
        ).rows[0];
        assert.equal(row.node_runtime.version, node.runtime!.version);
      });
      // 范围：真实持久化及端口故障注入边界；浏览器回复为显式夹具，不证明原生旧观察拒绝机制。
      await t.test('只在登记场景注入，保留原始状态与实际写入账本', async () => {
        const service = new Benchmarks(
          { query: sql.query.bind(sql) } as unknown as Database,
          config,
          RELEASE,
        );
        for (const scenario of [
          'invalid-target',
          'unknown-write',
          'read-only',
        ]) {
          const row = (
            await sql.query(
              'SELECT task_id FROM pr_benchmark_cases WHERE scenario=$1',
              [scenario],
            )
          ).rows[0];
          const grant = {
            id: randomUUID(),
            task: { taskId: row.task_id },
          } as ExecutionGrant;
          const operations: string[] = [];
          const ports = {
            command: async (_grant: unknown, _id: string, op: any) => {
              operations.push(op.type);
              if (scenario === 'unknown-write')
                await sql.query(
                  'UPDATE pr_benchmark_cases SET writes=\'[{"name":"Alice","city":"Hangzhou"}]\'::jsonb WHERE task_id=$1',
                  [row.task_id],
                );
              return {
                operationStatus:
                  scenario === 'invalid-target' && op.type === 'browser.act'
                    ? 'FAILED'
                    : 'SUCCEEDED',
                effect: 'HAPPENED',
                data: { actual: true },
                ...(scenario === 'invalid-target' && op.type === 'browser.act'
                  ? { error: { code: 'STALE_OBSERVATION' } }
                  : {}),
              };
            },
          } as unknown as ExecutionClient;
          const wrapped = benchmarkPorts(service, grant, ports);
          const result = await wrapped.command(
            grant,
            randomUUID(),
            {
              type: 'browser.act',
              action: 'click',
              target: '@save',
              observationId: 'old',
            },
            20000,
            new AbortController().signal,
          );
          const saved = (
            await sql.query(
              'SELECT * FROM pr_benchmark_cases WHERE task_id=$1',
              [row.task_id],
            )
          ).rows[0];
          const records = (
            await sql.query(
              'SELECT record FROM pr_benchmark_commands WHERE task_id=$1 ORDER BY created_at',
              [row.task_id],
            )
          ).rows.map((r) => r.record);
          assert.deepEqual(saved.api_release, RELEASE);
          if (scenario === 'invalid-target') {
            assert.deepEqual(operations, ['browser.observe', 'browser.act']);
            assert(saved.stale_rejected);
            assert.equal(records[0].origin, 'fault-injection');
          }
          if (scenario === 'unknown-write') {
            assert.equal(result.operationStatus, 'UNKNOWN');
            assert.equal(records[0].nativeStatus, 'SUCCEEDED');
            assert.equal(saved.writes.length, 1);
            assert(saved.injected);
          }
          if (scenario === 'read-only') {
            assert.deepEqual(operations, ['browser.act']);
            assert.equal(saved.injected, false);
            assert.equal(result.operationStatus, 'SUCCEEDED');
          }
        }
        let delegated = 0;
        const ordinary = {
          id: randomUUID(),
          task: { taskId: randomUUID() },
        } as ExecutionGrant;
        const ports = {
          command: async () => {
            delegated++;
            return { operationStatus: 'SUCCEEDED' };
          },
        } as unknown as ExecutionClient;
        await benchmarkPorts(service, ordinary, ports).command(
          ordinary,
          randomUUID(),
          { type: 'browser.observe' },
          1000,
          new AbortController().signal,
        );
        assert.equal(delegated, 1);
      });
      // 范围：服务重启后队列和已记录版本仍存在，缺结果/未关闭不能被归档为成功；不证明自然进程崩溃现场。
      await t.test('重启保留版本和排队，截止后失败归档可分页读取', async () => {
        await app.close();
        app = await buildApp(config, { logger: false });
        await app.ready();
        const list = (await request('/v1/admin/benchmarks')).json();
        assert.equal(list.runs.length, 1);
        assert.equal(list.runs[0].release.version, RELEASE.version);
        await sql.query(
          "UPDATE pr_benchmark_runs SET deadline_at=clock_timestamp()-interval '1 second'",
        );
        const done = await until(
          async () => request(`/v1/admin/benchmarks/${list.runs[0].id}`),
          (response) => response.json().state === 'FAILED',
        );
        const archive = parseBenchmark(JSON.stringify(done.json().run));
        assert(archive.completedAt);
        assert(
          archive.cases.every((item) =>
            item.checks.some((check) => !check.passed),
          ),
        );
        const saved = done.json().run;
        config.buildIdentity = { ...RELEASE, version: 'v0.2.0-test' };
        assert.deepEqual(
          (await request(`/v1/admin/benchmarks/${saved.id}`)).json().run,
          saved,
        );
        const again = await request('/v1/admin/benchmarks', {
          id: randomUUID(),
        });
        assert.equal(again.statusCode, 202, again.body);
        const groups = (await request('/v1/admin/benchmarks/versions')).json();
        assert.equal(groups.versions[0].count, 2);
        const filtered = (
          await request(`/v1/admin/benchmarks?version=${RELEASE.version}`)
        ).json();
        assert.equal(filtered.runs.length, 2);
        const page = (
          await request(`/v1/admin/benchmarks?after=${filtered.runs[0].id}`)
        ).json();
        assert.equal(page.runs.length, 1);
      });
    } finally {
      node.close();
      await app.close();
      await sql.end();
      await manager.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await manager.end();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
