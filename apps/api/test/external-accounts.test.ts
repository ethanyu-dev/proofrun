import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import {
  validateVerificationCaseV2,
  type VerificationCaseV2,
} from '@proofrun/contracts';
import { buildApp } from '../src/app.js';
import type { ApiConfig } from '../src/config.js';
import { compileCase } from '../src/modules/cases/structured.js';
import { sessionAuth } from '../src/modules/scheduling/auth.js';
import {
  executionDeadline,
  executionTimeoutCode,
} from '../src/modules/scheduling/execution-time.js';
import { SimulatedNode, SimulatedWorker, until } from './fixture.js';
import { devPassFixture } from './devpass-fixture.js';

/** 仅用于回环协议测试，不是部署凭据。 */
const ADMIN = 'external-fixture-admin-token-32-characters';
const WORKER = 'external-fixture-worker-token-32-characters';
const example = (id: string): VerificationCaseV2 => ({
  caseId: id,
  platform: '示例平台',
  entry: 'https://example.test/admin',
  session: {
    mode: 'external',
    external: {
      provider: 'devpass',
      platform: 'example-production',
      poolId: 'members',
      roles: ['member'],
    },
    requirements: [
      {
        id: 'member',
        description: '当前账号为测试成员',
        method: 'text',
        value: '测试成员',
      },
    ],
  },
  steps: [
    {
      type: 'verification',
      url: 'https://example.test/admin',
      exec_order: 1,
      description: '查看成员页面',
      policy: [],
      expected: ['显示测试成员'],
    },
  ],
  cleanup: [],
});
const profile: NonNullable<ApiConfig['caseProfile']> = {
  environment: { id: 'fixture', nodePool: 'external', allowIntervention: true },
  budget: { maxActions: 20 },
  executionMode: 'llm' as const,
  evidenceKinds: ['DOM' as const],
};

// 范围：外部身份输入、预算与硬期限纯逻辑；不执行 MCP、浏览器或模型。
test('外部来源显式冻结且人工暂停不能超过账号期限', () => {
  const input = example('compile');
  assert.equal(validateVerificationCaseV2(input), true);
  assert.equal(
    validateVerificationCaseV2({
      ...input,
      session: { ...input.session, mode: 'guest' },
    }),
    false,
  );
  assert.equal(
    validateVerificationCaseV2({
      ...input,
      session: { ...input.session, requirements: [] },
    }),
    false,
  );
  const task = compileCase(input, profile);
  assert.equal(
    task.sessionPlan?.external?.selector.platform,
    'example-production',
  );
  assert.equal(sessionAuth(task), null);
  assert.ok(task.sessionPlan!.external!.durationSeconds > 300);
  const context = {
    control_mode: 'HUMAN',
    deadline_at: new Date(100),
    human_deadline_at: new Date(500),
    external_expires_at: new Date(200),
  };
  assert.equal(executionDeadline(context), 200);
  assert.equal(executionTimeoutCode(context), 'EXTERNAL_ACCOUNT_EXPIRED');
  assert.throws(
    () =>
      compileCase(
        {
          ...input,
          steps: Array.from({ length: 24 }, (_, i) => ({
            ...input.steps[0]!,
            stepId: `step-${i}`,
            exec_order: i + 1,
          })) as VerificationCaseV2['steps'],
        },
        profile,
      ),
    /两小时/,
  );
});

// 范围：真实 PostgreSQL、MCP HTTP/JWE、WebSocket 的租约闭环；节点和业务结果为夹具，不代表 Chromium 或生产登录验收。
test(
  '外部账号恢复、私密投递、关闭后交还和双跑版本约束',
  { timeout: 90_000 },
  async (suite) => {
    assert.ok(process.env.PROOFRUN_TEST_DATABASE_URL, '需要独立测试数据库');
    const admin = new pg.Pool({
      connectionString: process.env.PROOFRUN_TEST_DATABASE_URL,
    });
    const name = `external_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(process.env.PROOFRUN_TEST_DATABASE_URL);
    url.pathname = `/${name}`;
    const sql = new pg.Pool({ connectionString: url.toString() });
    const directory = await mkdtemp(join(tmpdir(), 'proofrun-external-'));
    const fixture = await devPassFixture(directory);
    const config: ApiConfig = {
      databaseUrl: url.toString(),
      adminToken: ADMIN,
      workerToken: WORKER,
      publicUrl: 'http://127.0.0.1',
      artifactDirectory: directory,
      host: '127.0.0.1',
      port: 0,
      workerLeaseMs: 20_000,
      nodeLeaseMs: 20_000,
      tickMs: 50,
      caseProfile: profile,
      devPass: fixture.config,
    };
    // 范围：从主分支已经使用的 v30 数据库升级，避免迁移编号碰撞跳过外部账号表。
    const migrations = new URL('../migrations/', import.meta.url);
    await sql.query(
      'CREATE TABLE pr_migrations(version integer PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT clock_timestamp())',
    );
    for (const file of (await readdir(migrations))
      .filter(
        (file) =>
          /^\d{3}-.*\.sql$/.test(file) && Number(file.slice(0, 3)) <= 30,
      )
      .sort()) {
      await sql.query(await readFile(new URL(file, migrations), 'utf8'));
      await sql.query('INSERT INTO pr_migrations(version) VALUES($1)', [
        Number(file.slice(0, 3)),
      ]);
    }
    assert.equal(
      (await sql.query("SELECT to_regclass('pr_external_accounts') AS name"))
        .rows[0].name,
      null,
    );
    let app = await buildApp(config, { logger: false });
    assert.equal(
      (await sql.query('SELECT max(version) AS version FROM pr_migrations'))
        .rows[0].version,
      31,
    );
    assert.equal(
      (await sql.query("SELECT to_regclass('pr_external_accounts') AS name"))
        .rows[0].name,
      'pr_external_accounts',
    );
    let base = await app.listen({ host: '127.0.0.1', port: 0 });
    config.publicUrl = base;
    let node = new SimulatedNode(base, 'external', 2);
    node.externalAccounts = true;
    const workers: SimulatedWorker[] = [];
    const api = async (path: string, body?: unknown, token = ADMIN) => {
      const res = await fetch(base + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const data = await res.json();
      assert.ok(res.ok, JSON.stringify({ path, status: res.status, data }));
      return data;
    };
    const claim = () =>
      api(
        '/v1/worker/claim',
        {
          type: 'worker.claim',
          workerId: 'fixture-worker',
          structuredSteps: true,
          stepBudgetVersion: 1,
          identityVersion: 2,
          profileTabsVersion: 1,
          executionPlanVersion: 1,
        },
        WORKER,
      );
    const row = async (id: string) =>
      (
        await sql.query('SELECT * FROM pr_external_accounts WHERE task_id=$1', [
          `case-v2-${id}`,
        ])
      ).rows[0];
    const hurry = () =>
      sql.query(
        "UPDATE pr_external_accounts SET retry_at=clock_timestamp() WHERE state<>'RELEASED'",
      );
    const start = async () => {
      const { execution } = await until(claim, (r) => !!r.execution, 12_000);
      workers.push(new SimulatedWorker(base, execution));
      await until(
        () =>
          api(
            `/v1/executions/${execution.id}`,
            undefined,
            execution.leaseToken,
          ),
        (r) => r.state === 'RUNNING',
      );
      return execution;
    };
    try {
      await node.pair(ADMIN);
      // 范围：本子场景核实协议与持久状态，浏览器关闭由模拟节点报告。
      await suite.test(
        '分配响应丢失沿用原键，取消后等待物理关闭，交还响应丢失可恢复',
        async () => {
          fixture.state.dropGet = true;
          await api('/v2/cases', [example('recovery')]);
          await claim();
          await until(
            () => row('recovery'),
            (r) => r?.reason === 'EXTERNAL_ACCOUNT_TRANSPORT',
          );
          assert.equal(fixture.state.allocations.size, 1);
          await hurry();
          const execution = await start();
          assert.equal(fixture.state.allocations.size, 1);
          assert.ok(fixture.state.requests.length >= 2);
          assert.equal(
            new Set(fixture.state.requests.map((r) => r.request_id)).size,
            1,
          );
          const open = node.sessions.get(execution.sessionId)!.command;
          assert.equal(open.type, 'session.open');
          if (open.type !== 'session.open') throw new Error('夹具命令错误');
          assert.equal(open.authState, undefined);
          assert.equal(open.externalCookies?.[0]?.path, '/admin');
          assert.equal(open.externalCookies?.[0]?.same_site, 'Strict');
          assert.ok(open.externalAccount?.ttlMs);
          assert.ok(
            !JSON.stringify(execution).includes('fixture-private-cookie'),
          );
          assert.ok(
            !JSON.stringify(
              (await sql.query('SELECT envelope FROM pr_commands')).rows,
            ).includes('fixture-private-cookie'),
          );
          assert.ok(
            !JSON.stringify(await row('recovery')).includes(
              'fixture-private-cookie',
            ),
          );
          node.ignoreClose = true;
          await api('/v2/cases/recovery/cancel', {});
          await until(
            async () => {
              await hurry();
              return fixture.state.releases;
            },
            (r) => r.some((x) => !x.usage_stopped),
          );
          assert.equal(fixture.state.released.size, 0);
          fixture.state.dropRelease = true;
          node.closed(execution.sessionId);
          await until(
            async () => {
              await hurry();
              return fixture.state.released.size;
            },
            (n) => n === 1,
          );
          await until(
            async () => {
              await hurry();
              return row('recovery');
            },
            (r) => r.state === 'RELEASED',
          );
          assert.ok(
            fixture.state.releases.filter((r) => r.usage_stopped).length >= 2,
          );
          node.ignoreClose = false;
        },
      );
      // 范围：本子场景核实协议与持久状态，浏览器关闭由模拟节点报告。
      await suite.test('分配后 API 重启从数据库账本恢复同一租约', async () => {
        await api('/v2/cases', [example('restart')]);
        await claim();
        await until(
          () => row('restart'),
          (r) => r?.state === 'ALLOCATED',
        );
        const lease = (await row('restart')).lease_id;
        for (const w of workers.splice(0)) await w.close();
        node.close();
        await app.close();
        app = await buildApp(config, { logger: false });
        base = await app.listen({ host: '127.0.0.1', port: 0 });
        config.publicUrl = base;
        node = new SimulatedNode(base, 'external', 2);
        node.externalAccounts = true;
        await node.pair(ADMIN);
        // 新兼容节点承接尚未创建浏览器的预留，不修改数据库中的租约身份。
        const execution = await start();
        assert.equal((await row('restart')).lease_id, lease);
        await api('/v2/cases/restart/cancel', {});
        await until(
          () => row('restart'),
          (r) => r.state === 'RELEASED',
        );
        assert.ok(!node.sessions.has(execution.sessionId));
      });
      // 范围：本子场景核实协议与持久状态，浏览器关闭由模拟节点报告。
      await suite.test(
        '双跑额度独立，容量为一时等待，材料版本改变拒绝第二组',
        async () => {
          // 使用平台双跑模式提交；业务完成由夹具置位，不伪造真实验收报告。
          config.caseProfile!.executionMode = 'parallel';
          await api('/v2/cases', [example('comparison')]);
          const first = await start();
          assert.equal(first.task.comparison.arm, 'llm');
          await until(
            async () => {
              await claim();
              return fixture.state.requests;
            },
            (r) => r.some((x) => x.account_id === 'account-1'),
          );
          assert.equal(node.sessions.size, 1);
          fixture.state.version = 'material-2';
          await sql.query(
            "UPDATE pr_tasks SET state='COMPLETED',finished_at=clock_timestamp() WHERE id=$1",
            [first.task.taskId],
          );
          node.closed(first.sessionId);
          await until(
            () => row('comparison'),
            (r) => r.state === 'RELEASED',
          );
          await until(
            async () => {
              await hurry();
              await claim();
              return (
                await sql.query(
                  'SELECT state,error FROM pr_tasks WHERE id=$1',
                  ['comparison-case-v2-comparison-jev'],
                )
              ).rows[0];
            },
            (r) => r.state === 'ERROR',
          );
          const second = (
            await sql.query(
              'SELECT * FROM pr_external_accounts WHERE task_id=$1',
              ['comparison-case-v2-comparison-jev'],
            )
          ).rows[0];
          assert.equal(second.session_id, null);
          await until(
            async () => {
              await hurry();
              return (
                await sql.query(
                  'SELECT state FROM pr_external_accounts WHERE task_id=$1',
                  [second.task_id],
                )
              ).rows[0];
            },
            (r) => r.state === 'RELEASED',
          );
        },
      );
      // 范围：真实账本在明确账号异常或到期时关闭并交还；业务与节点仍为夹具。
      await suite.test(
        '管理员确认异常才反馈账号健康，账号期限优先于业务期限',
        async () => {
          config.caseProfile!.executionMode = 'llm';
          await api('/v2/cases', [example('feedback')]);
          const execution = await start();
          await api(`/v1/tasks/${execution.task.taskId}/account-feedback`, {
            outcome: 'credential_invalid',
            reason: '测试管理员核实登录已失效',
          });
          await until(
            () => row('feedback'),
            (r) => r.state === 'RELEASED',
          );
          const binding = await row('feedback');
          assert.ok(
            fixture.state.releases.some(
              (r) =>
                r.lease_id === binding.lease_id &&
                r.usage_stopped &&
                r.outcome === 'credential_invalid',
            ),
          );
          await api('/v2/cases', [example('expiry')]);
          const expired = await start();
          await sql.query(
            "UPDATE pr_external_accounts SET expires_at=clock_timestamp()+interval '10 seconds',retry_at=clock_timestamp() WHERE task_id=$1",
            [expired.task.taskId],
          );
          await until(
            () => row('expiry'),
            (r) => r.state === 'RELEASED',
          );
          const task = (
            await sql.query('SELECT state,error FROM pr_tasks WHERE id=$1', [
              expired.task.taskId,
            ])
          ).rows[0];
          assert.equal(task.state, 'ERROR');
          assert.equal(task.error.code, 'EXTERNAL_ACCOUNT_EXPIRED');
          assert.equal(
            (await row('expiry')).release_outcome,
            'execution_error',
          );
        },
      );
      // 范围：成功状态缺少租约证明仍被拒绝，必须完成关闭；不证明真实浏览器页面身份。
      await suite.test('节点未确认外部注入时禁止进入业务执行', async () => {
        node.externalProof = false;
        await api('/v2/cases', [example('bad-proof')]);
        const { execution } = await until(claim, (r) => !!r.execution, 12_000);
        workers.push(new SimulatedWorker(base, execution));
        await until(
          () => row('bad-proof'),
          (r) => r.state === 'RELEASED',
        );
        const task = (
          await sql.query('SELECT state,error FROM pr_tasks WHERE id=$1', [
            execution.task.taskId,
          ])
        ).rows[0];
        assert.equal(task.state, 'ERROR');
        assert.equal(task.error.code, 'EXTERNAL_ACCOUNT_PROOF_MISMATCH');
        node.externalProof = true;
      });
      // 范围：真实 JWE 接收方绑定被拒绝仍交还已分配租约；没有浏览器或真实登录。
      await suite.test(
        '材料绑定错误不创建会话，并交还已经分配的额度',
        async () => {
          config.caseProfile!.executionMode = 'parallel';
          fixture.state.wrongRecipient = true;
          await api('/v2/cases', [example('invalid-material')]);
          await claim();
          await until(
            async () => {
              await hurry();
              return row('invalid-material');
            },
            (r) => r?.state === 'RELEASED',
          );
          const binding = await row('invalid-material');
          assert.equal(binding.session_id, null);
          assert.ok(binding.lease_id);
          assert.equal(binding.release_outcome, 'execution_error');
          assert.ok(
            fixture.state.releases.some(
              (r) => r.lease_id === binding.lease_id && r.usage_stopped,
            ),
          );
          // 首组未取得可信材料时，另一组不能换账号或永久等待。
          await until(
            async () => {
              await claim();
              return (
                await sql.query(
                  'SELECT state,error FROM pr_tasks WHERE id=$1',
                  ['comparison-case-v2-invalid-material-jev'],
                )
              ).rows[0];
            },
            (r) => r.state === 'ERROR',
          );
          fixture.state.wrongRecipient = false;
        },
      );
      // 范围：API 重启后远端拒绝重新交付材料时，已知租约仍需交还；浏览器为未启动夹具。
      await suite.test(
        '恢复材料被拒绝时，已知租约不能永久停留在人工核实或等待状态',
        async () => {
          config.caseProfile!.executionMode = 'llm';
          for (const code of [
            'MATERIAL_REVOKED',
            'TEMPORARY_UNAVAILABLE',
          ] as const) {
            const id = `restore-${code.toLowerCase()}`;
            await api('/v2/cases', [example(id)]);
            await claim();
            await until(
              () => row(id),
              (r) => r?.state === 'ALLOCATED',
            );
            const lease = (await row(id)).lease_id;
            for (const w of workers.splice(0)) await w.close().catch(() => {});
            node.close();
            await app.close();
            fixture.state.replayError = code;
            app = await buildApp(config, { logger: false });
            base = await app.listen({ host: '127.0.0.1', port: 0 });
            config.publicUrl = base;
            node = new SimulatedNode(base, 'external', 2);
            node.externalAccounts = true;
            await node.pair(ADMIN);
            await until(
              async () => {
                await hurry();
                return row(id);
              },
              (r) => r.state === 'RELEASED',
            );
            const binding = await row(id);
            assert.equal(binding.session_id, null);
            assert.equal(binding.release_outcome, 'execution_error');
            assert.ok(
              fixture.state.releases.some(
                (r) => r.lease_id === lease && r.usage_stopped,
              ),
            );
            fixture.state.replayError = null;
          }
        },
      );
    } finally {
      for (const w of workers) await w.close().catch(() => {});
      node.close();
      await app.close();
      await fixture.close();
      await sql.end();
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
