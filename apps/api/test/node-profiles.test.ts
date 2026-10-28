import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import WebSocket from 'ws';
import { buildApp } from '../src/app.js';
import type { ApiConfig } from '../src/config.js';
import { SimulatedNode, task, until } from './fixture.js';

/** 仅供回环 HTTP/数据库/直连协议夹具，不连接实际业务或使用真实登录凭据。 */
const ADMIN = 'node-profile-console-admin-fixture-token'.padEnd(500, 'x');
const WORKER = 'node-profile-worker-fixture-token';

// 范围：真实 HTTP、PostgreSQL 和 WebSocket 验证维护生命周期；节点为协议夹具，磁盘和 Chrome 由独立测试覆盖。
test(
  '节点模板维护复用 HITL，发布、放弃和故障均保留真实状态',
  { timeout: 60_000 },
  async (t) => {
    assert.ok(process.env.PROOFRUN_TEST_DATABASE_URL);
    const admin = new pg.Pool({
      connectionString: process.env.PROOFRUN_TEST_DATABASE_URL,
    });
    const name = `node_profiles_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(process.env.PROOFRUN_TEST_DATABASE_URL);
    url.pathname = `/${name}`;
    const sql = new pg.Pool({ connectionString: url.toString() });
    const root = await mkdtemp(join(tmpdir(), 'proofrun-node-profiles-'));
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
    };
    const app = await buildApp(config, { logger: false });
    const base = await app.listen({ port: 0, host: '127.0.0.1' });
    config.publicUrl = base;
    const node = new SimulatedNode(base, 'profile', 4);
    const sockets: WebSocket[] = [];
    const request = (path: string, body?: unknown, token = ADMIN) =>
      fetch(base + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const api = async (path: string, body?: unknown) => {
      const response = await request(path, body);
      const data = await response.json();
      assert.ok(response.ok, JSON.stringify({ path, data }));
      return data;
    };
    const path = `/v1/nodes/${node.id}/profile`;
    const create = async () => {
      const { id } = await api(path, { url: 'https://example.test/login' });
      const state = await until(
        () => api(`/v1/node-profiles/${id}`),
        (data) => data.ready || data.closed,
      );
      assert.equal(state.ready, true, JSON.stringify(state));
      return state;
    };
    const bootstrap = (state: any) =>
      api('/v1/hitl/bootstrap', {
        id: state.id,
        token: state.path.split('/').at(-1),
      });
    const finish = async (state: any, discard = false) => {
      const ticket = await bootstrap(state);
      assert.equal(ticket.state.profileMaintenance, true);
      assert.ok(ticket.direct);
      const socket = new WebSocket(ticket.direct.controlUrl, { origin: base });
      sockets.push(socket);
      await once(socket, 'open');
      const initial = once(socket, 'message');
      socket.send(JSON.stringify({ type: 'authenticate', ...ticket.direct }));
      const [message] = await initial;
      assert.equal(JSON.parse(message.toString()).mode, 'HUMAN');
      socket.send(
        JSON.stringify(
          discard
            ? { type: 'unable', reason: '放弃维护' }
            : { type: 'complete', confirmedItems: [] },
        ),
      );
    };
    try {
      await node.pair(ADMIN);
      await until(
        () => api('/v1/nodes'),
        (data) => data.nodes.some((n: any) => n.online),
      );
      // 范围：管理员授权、输入校验和能力缺口；不模拟真实资源压力。
      await t.test('鉴权与能力门禁', async () => {
        assert.equal(
          (await request(path, { url: 'https://example.test' }, WORKER)).status,
          401,
        );
        assert.equal(
          (await request(path, { url: 'file:///etc/passwd' })).status,
          422,
        );
        node.nodeDefaultProfileVersion = undefined;
        node.heartbeat();
        await until(
          () => api('/v1/nodes'),
          (data) => !data.nodes[0].capabilities.nodeDefaultProfileVersion,
        );
        assert.equal(
          (await request(path, { url: 'https://example.test' })).status,
          409,
        );
        node.nodeDefaultProfileVersion = 1;
        node.heartbeat();
        await until(
          () => api('/v1/nodes'),
          (data) => data.nodes[0].capabilities.nodeDefaultProfileVersion === 1,
        );
      });
      // 范围：重复创建返回原会话、完成发布后查询与重连一致；不证明模板实际包含任何登录态。
      await t.test('维护完成发布一次，关闭后显示保存结果', async () => {
        const state = await create();
        assert.equal(
          (await api(path, { url: 'https://another.test' })).id,
          state.id,
        );
        assert.equal((await api(path)).id, state.id);
        const session = [...node.sessions.values()][0]!;
        assert.equal(session.command.type, 'session.open');
        assert.equal((session.command as any).profileMode, 'maintenance');
        await finish(state);
        const saved = await until(
          () => api(`/v1/node-profiles/${state.id}`),
          (data) => data.closed && data.publishState === 'SAVED',
        );
        assert.ok(saved.profile.version);
        assert.equal((await bootstrap(state)).state.type, 'completed');
        assert.equal(node.calls.get(`node-profile-save-${state.id}`), 1);
        assert.equal((await api(path)).id, null);
        const nodes = await until(
          () => api('/v1/nodes'),
          (data) =>
            data.nodes[0].default_profile?.version === saved.profile.version,
        );
        assert.equal(
          nodes.nodes[0].default_profile.sessionId,
          session.sessionId,
        );
        const transitions = await sql.query(
          "SELECT count(*)::int n FROM pr_commands WHERE execution_id=(SELECT id FROM pr_executions WHERE task_id=$1) AND envelope#>>'{command,mode}'='AUTO'",
          [state.taskId],
        );
        assert.equal(transitions.rows[0].n, 0);
      });
      // 范围：原始验证入口冻结复制来源，访客例外不继承，旧能力不能接单；节点返回仍为模拟证据。
      await t.test('验证任务继承所分配节点模板，访客保持空白', async () => {
        for (const mode of ['default', 'guest', 'guest-plan']) {
          const guest = mode !== 'default';
          const definition = {
            ...task('profile'),
            ...(mode === 'guest-plan'
              ? {
                  executionPlan: {
                    version: 1,
                    environment: {
                      mode: 'guest',
                      source: 'explicit',
                      basis: [],
                      resolverVersion: 2,
                    },
                    evidenceKinds: ['SCREENSHOT'],
                    requiredCapabilities: [],
                  },
                }
              : guest
                ? {
                    sessionPlan: {
                      version: 1,
                      mode: 'guest',
                      profileSource: 'empty',
                      candidates: [],
                      requirements: [],
                      preparationMs: 120000,
                    },
                  }
                : {}),
          };
          await api('/v1/tasks', definition);
          await api('/v1/tasks', definition);
          if (!guest) {
            node.nodeDefaultProfileVersion = undefined;
            node.heartbeat();
            await until(
              () => api('/v1/nodes'),
              (data) => !data.nodes[0].capabilities.nodeDefaultProfileVersion,
            );
            const blocked = await request(
              '/v1/worker/claim',
              {
                type: 'worker.claim',
                workerId: randomUUID(),
                identityVersion: 2,
              },
              WORKER,
            );
            assert.equal((await blocked.json()).execution, null);
            node.nodeDefaultProfileVersion = 1;
            node.heartbeat();
            await until(
              () => api('/v1/nodes'),
              (data) =>
                data.nodes[0].capabilities.nodeDefaultProfileVersion === 1,
            );
          }
          const claimed = await request(
            '/v1/worker/claim',
            {
              type: 'worker.claim',
              workerId: randomUUID(),
              identityVersion: 2,
              executionPlanVersion: 1,
            },
            WORKER,
          );
          const { execution } = await claimed.json();
          assert.ok(execution);
          await until(
            () => node.sessions.size,
            (count) => count === 1,
          );
          const open = [...node.sessions.values()][0]!;
          assert.equal(
            (open.command as any).profileMode,
            guest ? undefined : 'node-default',
          );
          const record = (
            await sql.query('SELECT definition FROM pr_tasks WHERE id=$1', [
              definition.taskId,
            ])
          ).rows[0].definition;
          assert.equal(
            record.sessionPlan.profileSource,
            guest ? 'empty' : 'node-default',
          );
          await api(`/v1/tasks/${definition.taskId}/cancel`, {});
          await until(
            () => node.sessions.size,
            (count) => count === 0,
          );
        }
      });
      // 范围：放弃和失败均不改变已发布指针；结果来自模拟节点，实际文件保护由 Rust 测试覆盖。
      await t.test('放弃与保存失败保留旧版本', async () => {
        const old = node.defaultProfile!.version;
        const discarded = await create();
        await finish(discarded, true);
        await until(
          () => api(`/v1/node-profiles/${discarded.id}`),
          (data) => data.closed && data.publishState === 'DISCARDED',
        );
        assert.equal(node.defaultProfile!.version, old);
        assert.equal(
          node.calls.has(`node-profile-save-${discarded.id}`),
          false,
        );
        node.profileSaveFailure = true;
        const failed = await create();
        await finish(failed);
        await until(
          () => api(`/v1/node-profiles/${failed.id}`),
          (data) => data.closed && data.publishState === 'FAILED',
        );
        assert.equal((await bootstrap(failed)).state.type, 'unable');
        assert.equal(node.defaultProfile!.version, old);
        node.profileSaveFailure = false;
      });
      // 范围：已提交保存后禁止取消竞争，重连只查询；恢复通过节点发布元数据，不重放发布命令。
      await t.test('保存回执丢失通过心跳元数据恢复', async () => {
        const state = await create();
        node.holdProfileSave = true;
        await finish(state);
        await until(
          () => api(`/v1/node-profiles/${state.id}`),
          (data) => data.publishState === 'SAVING',
        );
        assert.equal(
          (await request(`/v1/node-profiles/${state.id}/close`, {})).status,
          409,
        );
        assert.equal((await bootstrap(state)).state.finalizing, true);
        const session = [...node.sessions.values()][0]!;
        node.defaultProfile = {
          version: randomUUID(),
          updatedAt: new Date().toISOString(),
          sessionId: session.sessionId,
        };
        node.heartbeat();
        await until(
          () => api(`/v1/node-profiles/${state.id}`),
          (data) => data.closed && data.publishState === 'SAVED',
        );
        assert.equal((await bootstrap(state)).state.type, 'completed');
        node.holdProfileSave = false;
      });
      // 范围：节点确定拒绝维护启动时不能排队给普通 Worker；不验证真实 Chrome 启动故障。
      await t.test('维护启动拒绝不会转成业务任务', async () => {
        node.rejectOpen = true;
        const { id } = await api(path, { url: 'https://example.test' });
        const state = await until(
          () => api(`/v1/node-profiles/${id}`),
          (data) => data.closed,
        );
        assert.equal(state.ready, false);
        assert.equal(
          (
            await sql.query('SELECT state FROM pr_tasks WHERE id=$1', [
              state.taskId,
            ])
          ).rows[0].state,
          'ERROR',
        );
      });
    } finally {
      for (const socket of sockets) socket.terminate();
      node.close();
      await app.close();
      await sql.end();
      await admin.query(`DROP DATABASE ${name}`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  },
);
