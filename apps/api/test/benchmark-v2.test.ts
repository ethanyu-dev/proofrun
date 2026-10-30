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
import { benchmarkRuntimeLimits } from '@proofrun/contracts/benchmark-scenarios';
import { v2BenchmarkCases } from '@proofrun/contracts/benchmark-v2';
import {
  DEPLOYED_V2_BENCHMARK_SUITE,
  parseBenchmark,
} from '@proofrun/contracts/benchmark';
import { benchmarkPorts } from '../src/modules/benchmarks/driver.js';
import { Benchmarks } from '../src/modules/benchmarks/service.js';
import type { Database } from '../src/db.js';
import type { ExecutionClient } from '@proofrun/execution-driver/execution/runner';

/** 隔离协议测试身份，不代表实际发布或供应商模型。 */
const RELEASE = {
  version: 'fixture-v2',
  buildId: 'fixture',
  commit: 'a'.repeat(40),
  sourceFingerprint: 'b'.repeat(64),
  kind: 'release' as const,
};
const ADMIN = 'benchmark-v2-fixture-admin';
const WORKER = 'benchmark-v2-fixture-worker';

// 范围：真实 PostgreSQL/HTTP、调度和归档；模型记录、节点与业务报告是夹具，不验收生产站点或真实模型能力。
test(
  'V2 线上任务保留原预算，按测试集隔离并归档失败',
  { timeout: 60000 },
  async () => {
    const manager = new pg.Pool({
      connectionString: process.env.PROOFRUN_TEST_DATABASE_URL!,
    });
    const name = `proofrun_v2_${randomUUID().replaceAll('-', '')}`;
    await manager.query(`CREATE DATABASE ${name}`);
    const url = new URL(process.env.PROOFRUN_TEST_DATABASE_URL!);
    url.pathname = `/${name}`;
    const directory = await mkdtemp(join(tmpdir(), 'proofrun-benchmark-v2-'));
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
      workerLeaseMs: 30000,
      nodeLeaseMs: 30000,
      tickMs: 25,
      executionRuntimeVersion: 1,
      benchmarkNodePool: 'benchmark-v2-fixture',
      benchmarkEnvironment: 'integration-only',
      buildIdentity: RELEASE,
    };
    const app = await buildApp(config, { logger: false });
    await app.listen({ host: '127.0.0.1', port: 0 });
    config.publicUrl = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const node = new SimulatedNode(
      config.publicUrl,
      config.benchmarkNodePool!,
      1,
    );
    node.fullProfile = true;
    // 固定历史任务比默认夹具的一小时会话更长；只扩展模拟节点的宿主能力，不改任务预算。
    const send = node.send.bind(node);
    node.send = (value: any) => {
      if (value.type === 'node.heartbeat')
        value.limits.maxSessionMs = 3 * 60 * 60_000;
      send(value);
    };
    const request = (path: string, body?: any, token = ADMIN) =>
      app.inject({
        method: body === undefined ? 'GET' : 'POST',
        url: path,
        headers: { authorization: `Bearer ${token}` },
        ...(body === undefined ? {} : { payload: body }),
      });
    try {
      // 创建只接受管理员、固定测试集和独立身份；未知测试集不能回退到基础套件。
      const id = randomUUID();
      assert.equal(
        (await request('/v1/admin/benchmarks', { id, family: 'v2' }, WORKER))
          .statusCode,
        401,
      );
      assert.equal(
        (await request('/v1/admin/benchmarks', { id, family: 'other' }))
          .statusCode,
        400,
      );
      for (let i = 0; i < 2; i++)
        assert.equal(
          (await request('/v1/admin/benchmarks', { id, family: 'v2' }))
            .statusCode,
          202,
        );
      assert.equal(
        (await request('/v1/admin/benchmarks', { id, family: 'browser' }))
          .statusCode,
        409,
      );
      const rows = (
        await sql.query(
          'SELECT b.*,t.definition FROM pr_benchmark_cases b JOIN pr_tasks t ON t.id=b.task_id ORDER BY b.scenario',
        )
      ).rows;
      assert.equal(rows.length, 2);
      const sources = v2BenchmarkCases((id) => id, {
        id: 'fixture',
        nodePool: 'fixture',
        allowIntervention: false,
      });
      for (const row of rows) {
        const original = sources.find((source) => source.id === row.scenario)!;
        for (const key of [
          'steps',
          'budget',
          'stepBudget',
          'acceptanceCriteria',
          'profilePlan',
          'executionPlan',
        ] as const)
          assert.deepEqual(row.definition[key], original.task[key]);
        assert.equal(
          row.source.sourceDefinitionSha256,
          original.sourceDefinitionSha256,
        );
        assert.equal(
          row.definition.environment.nodePool,
          config.benchmarkNodePool,
        );
        assert.equal(row.definition.environment.allowIntervention, false);
        assert.equal(row.definition.resourceKey, undefined);
      }
      const pending = (await request(`/v1/admin/benchmarks/${id}`)).json();
      assert.equal(
        parseBenchmark(JSON.stringify(pending.run)).suite,
        DEPLOYED_V2_BENCHMARK_SUITE,
      );
      assert.equal(pending.run.cases[0].verification.steps.length, 0);
      assert.equal(pending.run.cases[0].facts, undefined);
      assert.equal(
        (await request('/v1/admin/benchmarks')).json().runs.length,
        0,
      );
      assert.equal(
        (await request('/v1/admin/benchmarks?family=v2')).json().runs.length,
        1,
      );
      assert.equal(
        (await request('/v1/admin/benchmarks/versions?family=v2')).json()
          .versions[0].version,
        RELEASE.version,
      );
      assert.equal(
        (await request('/v1/admin/benchmarks/versions')).json().versions.length,
        0,
      );
      assert.equal(
        (await request('/v1/admin/benchmarks?family=wrong')).statusCode,
        400,
      );
      assert.equal(
        (await request('/v1/admin/benchmarks/status')).json().activeFamily,
        'v2',
      );
      await node.pair(ADMIN);
      const claim = (version: number) =>
        request(
          '/v1/worker/claim',
          {
            type: 'worker.claim',
            workerId: `fixture-${version}`,
            structuredSteps: true,
            stepBudgetVersion: 1,
            identityVersion: 2,
            profileTabsVersion: 1,
            executionPlanVersion: 1,
            runtimeVersion: 1,
            benchmarkVersion: version,
          },
          WORKER,
        );
      assert.equal((await claim(1)).json().execution, null);
      const grant = (
        await until(
          () => claim(2),
          (response) => !!response.json().execution,
        )
      ).json().execution;
      assert.equal(grant.benchmark.family, 'v2');
      const limits = benchmarkRuntimeLimits('v2', grant.task);
      assert(limits.maxTurns > 200);
      await until(
        async () =>
          (
            await sql.query('SELECT state FROM pr_tasks WHERE id=$1', [
              grant.task.taskId,
            ])
          ).rows[0].state,
        (state) => state === 'RUNNING',
      );
      const registered = await request(
        `/v1/executions/${grant.id}/benchmark-build`,
        {
          release: RELEASE,
          model: {
            name: 'fixture-model',
            vision: false,
            tokenParameter: 'max_tokens',
            maxTokens: 512,
            thinking: 'default',
            reasoningEffort: 'default',
            endpointFingerprint: 'c'.repeat(64),
            modelMs: 1000,
          },
        },
        grant.leaseToken,
      );
      assert.equal(registered.statusCode, 200, registered.body);
      // 传输协议容纳多步骤总量，但服务端拒绝基础额度或擅自增加的 V2 额度。
      for (const maxTurns of [12, limits.maxTurns + 1]) {
        const response = await request(
          `/v1/executions/${grant.id}/runtime`,
          {
            type: 'start',
            config: {
              ...limits,
              maxTurns,
              model: 'fixture-model',
              vision: false,
            },
          },
          grant.leaseToken,
        );
        assert.equal(
          response.json().code,
          'BENCHMARK_CONFIG_CONFLICT',
          response.body,
        );
      }
      assert.equal(
        (await request(`/v1/benchmark-fixtures/${grant.task.taskId}`))
          .statusCode,
        404,
      );
      // 同一执行内多个步骤的轮次号可重复；归档必须按调用 ID 绑定到相应步骤。
      const calls = ['step-1', 'step-2'].map((stepId, index) => ({
        id: randomUUID(),
        callIndex: index + 1,
        decisionIndex: 1,
        stepId,
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
                  { function: { name: 'network_requests', arguments: '{}' } },
                ],
              },
            },
          ],
        }),
        requestSha256: 'e'.repeat(64),
        error: null,
        promptTokens: 1,
        completionTokens: 1,
        elapsedMs: 1,
        imagesOmitted: 0,
        archived: false,
      }));
      for (const call of calls)
        await sql.query(
          'INSERT INTO pr_model_calls(id,execution_id,call_index,record,start_hash) VALUES($1,$2,$3,$4,$5)',
          [call.id, grant.id, call.callIndex, call, call.id],
        );
      const service = new Benchmarks(
        { query: sql.query.bind(sql) } as unknown as Database,
        config,
        RELEASE,
      );
      const wrapped = benchmarkPorts(service, grant, {
        command: async () => ({
          operationStatus: 'SUCCEEDED',
          effect: 'NOT_APPLICABLE',
          data: {},
        }),
      } as unknown as ExecutionClient);
      await Promise.all(
        ['step-1', 'step-2'].map((step) =>
          wrapped.command(
            grant,
            randomUUID(),
            { type: 'browser.observe' },
            1000,
            new AbortController().signal,
            0,
            step,
          ),
        ),
      );
      const commands = (
        await sql.query(
          'SELECT record FROM pr_benchmark_commands WHERE task_id=$1',
          [grant.task.taskId],
        )
      ).rows.map((row) => row.record);
      for (const command of commands)
        assert.equal(
          command.callId,
          calls.find((call) => call.stepId === command.stepId)!.id,
        );
      assert(commands.every((command) => !command.fault));
      await assert.rejects(
        wrapped.command(
          grant,
          randomUUID(),
          {
            type: 'browser.act',
            action: 'navigate',
            target: 'https://outside.test',
          },
          1000,
          new AbortController().signal,
        ),
        /任务之外/,
      );
      // 真实运行时接受冻结的完整额度；不等待供应商模型，后续截止归档故意记录为失败。
      const started = await request(
        `/v1/executions/${grant.id}/runtime`,
        {
          type: 'start',
          config: { ...limits, model: 'fixture-model', vision: false },
        },
        grant.leaseToken,
      );
      assert.equal(started.statusCode, 200, started.body);
      assert.deepEqual(
        (
          await sql.query(
            'SELECT config FROM pr_execution_runtimes WHERE execution_id=$1',
            [grant.id],
          )
        ).rows[0].config.maxTurns,
        limits.maxTurns,
      );
      const steps = grant.task.steps.map((step: any) => ({
        stepId: step.stepId,
        status: 'SKIPPED',
        summary: '夹具：能力缺口不能算通过',
      }));
      await sql.query('UPDATE pr_tasks SET step_results=$2 WHERE id=$1', [
        grant.task.taskId,
        JSON.stringify(steps),
      ]);
      await sql.query(
        "UPDATE pr_benchmark_runs SET deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [id],
      );
      const finished = (
        await until(
          () => request(`/v1/admin/benchmarks/${id}`),
          (response) => response.json().state === 'FAILED',
        )
      ).json();
      const archived = parseBenchmark(JSON.stringify(finished.run));
      assert(archived.completedAt);
      const item = archived.cases.find(
        (item) => item.id === grant.benchmark.caseId,
      )!;
      assert.equal(item.calls.length, 2);
      assert.equal(item.verification!.task.taskId, grant.task.taskId);
      assert(
        item.checks.some(
          (check) => check.name === '原任务全部步骤与清理完成' && !check.passed,
        ),
      );
      // 归档冻结后不受下一轮运行或源码内清单变化影响；相同版本可以重新创建完整双任务。
      assert.equal(
        (
          await request('/v1/admin/benchmarks', {
            id: randomUUID(),
            family: 'v2',
          })
        ).statusCode,
        202,
      );
      assert.equal(
        (await request('/v1/admin/benchmarks?family=v2')).json().runs.length,
        2,
      );
      assert.deepEqual(
        (await request(`/v1/admin/benchmarks/${id}`)).json().run,
        finished.run,
      );
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
