import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import WebSocket from 'ws';
import {
  validateVerificationReport,
  validateCaseResultV2,
} from '@proofrun/contracts';
import type { ApiConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { SimulatedNode, SimulatedWorker, until } from './fixture.js';

/** 仅供独立数据库、回环服务与协议夹具使用。 */
const ADMIN = 'library-http-admin-fixture-credential';
const WORKER = 'library-http-worker-fixture-credential';

// 范围：真实 HTTP、WebSocket、数据库的默认选取、私密投递、人工发布和无法执行；模型及磁盘复制由其他测试覆盖。
test(
  '身份库默认流程贯通选择、HITL 成功发布与整例无法执行',
  { timeout: 30_000 },
  async () => {
    assert.ok(process.env.PROOFRUN_TEST_DATABASE_URL);
    const admin = new pg.Pool({
      connectionString: process.env.PROOFRUN_TEST_DATABASE_URL,
    });
    const name = `library_http_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(process.env.PROOFRUN_TEST_DATABASE_URL);
    url.pathname = `/${name}`;
    const sql = new pg.Pool({ connectionString: url.toString() });
    const root = await mkdtemp(join(tmpdir(), 'proofrun-library-http-'));
    const config: ApiConfig = {
      databaseUrl: url.toString(),
      adminToken: ADMIN,
      workerToken: WORKER,
      publicUrl: 'http://127.0.0.1',
      artifactDirectory: root,
      host: '127.0.0.1',
      port: 0,
      workerLeaseMs: 10_000,
      nodeLeaseMs: 10_000,
      tickMs: 30,
      caseProfile: {
        environment: {
          id: 'fixture',
          nodePool: 'library',
          allowIntervention: true,
        },
        budget: { timeoutMs: 60_000, maxActions: 20 },
        executionMode: 'parallel' as const,
        evidenceKinds: ['DOM' as const],
      },
    };
    const app = await buildApp(config, { logger: false });
    const base = await app.listen({ port: 0, host: '127.0.0.1' });
    config.publicUrl = base;
    const node = new SimulatedNode(base, 'library', 2);
    node.fullProfile = true;
    node.identityPreparation = true;
    node.restartOnAuthSave = true;
    const workers: SimulatedWorker[] = [];
    const sockets: WebSocket[] = [];
    const api = async (path: string, body?: unknown, token = ADMIN) => {
      const response = await fetch(base + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const data = await response.json();
      assert.ok(
        response.ok,
        JSON.stringify({ path, status: response.status, data }),
      );
      return data;
    };
    try {
      await node.pair(ADMIN);
      await until(
        () => api('/v1/nodes'),
        (data) =>
          data.nodes.some((item: any) => item.id === node.id && item.online),
      );
      const library = await api('/v1/admin/identity-library', {
        url: 'https://identity.example.test/app',
        cookies: 'session=http-fixture-secret',
        name: '成员账号',
        type: '成员',
        description: '普通成员，可访问测试团队',
        concurrency: 2,
      });
      const identity = library.identities[0];
      await api('/v2/cases', [
        {
          caseId: 'library-default',
          platform: '身份测试',
          entry: 'https://identity.example.test/app',
          steps: [
            {
              type: 'verification',
              url: 'https://identity.example.test/app',
              exec_order: 1,
              description: '以普通成员检查团队页面',
              policy: ['使用成员账号'],
              expected: ['显示团队'],
            },
          ],
          cleanup: [],
        },
      ]);
      const claim = () =>
        api(
          '/v1/worker/claim',
          {
            type: 'worker.claim',
            workerId: randomUUID(),
            structuredSteps: true,
            stepBudgetVersion: 1,
            identityVersion: 2,
            profileTabsVersion: 1,
            executionPlanVersion: 1,
          },
          WORKER,
        );
      assert.equal((await claim()).execution, null);
      const { selection } = await api(
        '/v1/worker/identity-selection/claim',
        {},
        WORKER,
      );
      assert.equal(selection.candidates[0].id, identity.id);
      assert.ok(!JSON.stringify(selection).includes('http-fixture-secret'));
      await api(
        '/v1/worker/identity-selection/finish',
        {
          taskId: selection.taskId,
          token: selection.token,
          identityId: identity.id,
          needsIdentity: true,
          reason: '符合普通成员要求',
        },
        WORKER,
      );
      assert.equal(
        (await api('/v1/worker/identity-selection/claim', {}, WORKER))
          .selection,
        null,
      );
      const executions: any[] = [];
      for (let index = 0; index < 2; index++) {
        const { execution } = await until(claim, (value) => !!value.execution);
        executions.push(execution);
        workers.push(new SimulatedWorker(base, execution));
        await until(
          () =>
            api(
              `/v1/executions/${execution.id}`,
              undefined,
              execution.leaseToken,
            ),
          (view) => view.state === 'RUNNING',
        );
        assert.equal(execution.task.sessionPlan.candidates[0].id, identity.id);
        assert.ok(!JSON.stringify(execution).includes('http-fixture-secret'));
        const open = node.sessions.get(execution.sessionId)!.command;
        assert.equal(open.type, 'session.open');
        if (open.type === 'session.open') {
          assert.equal(open.authState?.fullProfile, true);
          assert.equal(
            open.identitySeed?.cookies[0]?.value,
            'http-fixture-secret',
          );
        }
      }
      assert.ok(
        !JSON.stringify(
          (await sql.query('SELECT envelope FROM pr_commands')).rows,
        ).includes('http-fixture-secret'),
      );
      assert.equal(
        (await api('/v1/admin/identity-library')).identities[0].baselineReady,
        false,
      );
      const connect = async (link: any) => {
        const messages: any[] = [];
        const socket = new WebSocket(
          `${base.replace(/^http/, 'ws')}/v1/hitl/connect`,
          { origin: base },
        );
        sockets.push(socket);
        socket.on('message', (data) =>
          messages.push(JSON.parse(data.toString())),
        );
        await new Promise<void>((resolve, reject) => {
          socket.once('open', resolve);
          socket.once('error', reject);
        });
        socket.send(
          JSON.stringify({
            type: 'authenticate',
            id: link.id,
            token: link.path.split('/').at(-1),
          }),
        );
        return { socket, messages };
      };
      const intervene = async (execution: any) => {
        await api(`/v1/admin/executions/${execution.id}/intervene`, {
          type: 'execution.intervene',
          controlRevision: 0,
          reason: '确认成员权限',
          items: ['使用指定团队成员账号'],
        });
        await api(
          `/v1/executions/${execution.id}/control`,
          {
            type: 'execution.control',
            action: 'acknowledge',
            controlRevision: 1,
          },
          execution.leaseToken,
        );
        const { intervention } = await api(
          `/v1/admin/executions/${execution.id}/intervention`,
        );
        const connection = await connect(intervention);
        await until(
          async () => connection.messages,
          (rows) => rows.some((row) => row.type === 'frame'),
        );
        return { ...connection, intervention };
      };
      const first = await intervene(executions[0]);
      first.socket.send(
        JSON.stringify({ type: 'complete', confirmedItems: [0] }),
      );
      await until(
        () => api('/v1/admin/identity-library'),
        (data) => data.identities[0].baselineReady,
      );
      await until(
        async () => first.messages,
        (rows) => rows.some((row) => row.type === 'completed'),
      );
      assert.equal(
        (
          await sql.query(
            "SELECT count(*)::int n FROM pr_commands WHERE kind='browser.auth.save'",
          )
        ).rows[0].n,
        1,
      );
      const second = await intervene(executions[1]);
      const reason = '团队没有可用成员席位，无法执行此 case';
      second.socket.send(JSON.stringify({ type: 'unable', reason }));
      await until(
        async () => second.messages,
        (rows) => {
          const error = rows.find((row) => row.type === 'error');
          assert.ok(!error, JSON.stringify(error));
          return rows.some(
            (row) => row.type === 'unable' && row.reason === reason,
          );
        },
      );
      const result = await until(
        () => api('/v2/cases/library-default'),
        (data) =>
          data.executionOutcome?.category === 'HUMAN_UNEXECUTABLE' ||
          data.state === 'COMPLETED',
      );
      assert.ok(
        validateCaseResultV2(result),
        JSON.stringify(validateCaseResultV2.errors),
      );
      assert.ok(JSON.stringify(result).includes(reason));
      const tasks = (await sql.query('SELECT report FROM pr_tasks')).rows;
      assert.equal(tasks.length, 2);
      for (const row of tasks)
        assert.ok(
          validateVerificationReport(row.report),
          JSON.stringify(validateVerificationReport.errors),
        );
      assert.ok(
        tasks.every((row) => row.report?.humanDecision?.reason === reason),
      );
      assert.equal(
        (
          await sql.query(
            "SELECT count(*)::int n FROM pr_commands WHERE kind='browser.auth.save'",
          )
        ).rows[0].n,
        1,
      );
      const reconnect = await connect(second.intervention);
      await until(
        async () => reconnect.messages,
        (rows) => {
          const error = rows.find((row) => row.type === 'error');
          assert.ok(!error, JSON.stringify(error));
          return rows.some(
            (row) => row.type === 'unable' && row.reason === reason,
          );
        },
      );
    } finally {
      for (const socket of sockets) socket.terminate();
      for (const worker of workers) worker.close();
      node.close();
      await app.close();
      await sql.end();
      await admin.query(`DROP DATABASE ${name}`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  },
);
