import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import WebSocket from 'ws';
import { buildApp } from '../src/app.js';
import type { ApiConfig } from '../src/config.js';
import { SimulatedNode, until } from './fixture.js';

/** 凭据仅用于回环协议夹具，不连接真实节点或外部网站。 */
const ADMIN = 'node-profile-console-admin-fixture-token'.padEnd(500, 'x');
const WORKER = 'node-profile-worker-fixture-token';

// 范围：真实 HTTP、WS、数据库的鉴权、容量、保存和关闭；节点为协议夹具，不证明 Chrome 登录。
test(
  'Console 节点模板维护的完整生命周期',
  { timeout: 45_000 },
  async (suite) => {
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
    const node = new SimulatedNode(base, 'profile', 1);
    const sockets: WebSocket[] = [];
    const request = async (path: string, body?: unknown, token = ADMIN) =>
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
      await until(
        () => api('/v1/nodes'),
        (data) => data.nodes[0].occupied === 0,
      );
      const result = await api(path, { url: 'https://login.example.test/' });
      await until(
        () => api(`/v1/node-profiles/${result.id}`),
        (value) => value.ready,
      );
      return result.id as string;
    };
    const connect = async (
      id: string,
      token = ADMIN,
      endpoint = 'node-profiles',
    ) => {
      const socket = new WebSocket(
        `${base.replace(/^http/, 'ws')}/v1/${endpoint}/connect`,
        { origin: base },
      );
      const messages: any[] = [];
      sockets.push(socket);
      socket.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
      socket.on('error', () => {});
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
      });
      socket.send(JSON.stringify({ type: 'authenticate', id, token }));
      return { socket, messages };
    };
    const savedCount = async () =>
      Number(
        (
          await sql.query(
            "SELECT count(*) AS n FROM pr_commands WHERE kind='browser.auth.save'",
          )
        ).rows[0].n,
      );
    try {
      await node.pair(ADMIN);
      await until(
        () => api('/v1/nodes'),
        (data) => data.nodes.some((n: any) => n.online),
      );
      // 范围：未认证 HTTP、旧节点能力和 URL 校验；不验证实际站点可达性。
      await suite.test('Console 鉴权和节点能力准入', async () => {
        assert.equal(
          (await request(path, { url: 'https://example.test' }, WORKER)).status,
          401,
        );
        assert.equal((await request(path, undefined, WORKER)).status, 401);
        assert.equal(
          (await request(path, { url: 'file:///etc/passwd' })).status,
          400,
        );
        const unsupported = await request(path, {
          url: 'https://example.test',
        });
        assert.equal(
          (await unsupported.json()).code,
          'NODE_PROFILE_UNSUPPORTED',
        );
        node.fullProfile = true;
        node.nodeProfileManagement = true;
        node.heartbeat();
        await until(
          () => api('/v1/nodes'),
          (data) => data.nodes[0].capabilities.nodeProfileManagement,
        );
      });
      // 范围：重复创建、任务列表隔离、首帧凭据与任务链接隔离；画面内容为夹具。
      await suite.test('创建恢复和鉴权边界', async () => {
        const id = await create();
        assert.equal(
          (await api(path, { url: 'https://another.example.test' })).id,
          id,
        );
        assert.equal((await api(path)).id, id);
        assert.equal((await api('/v1/tasks')).tasks.length, 0);
        const opened = [...node.sessions.values()][0]!;
        assert.equal(opened.command.type, 'session.open');
        if (opened.command.type === 'session.open')
          assert.equal(opened.command.authState?.nodeTemplate, true);
        for (const [token, endpoint] of [
          [WORKER, 'node-profiles'],
          [ADMIN, 'hitl'],
        ]) {
          const denied = await connect(id, token, endpoint);
          await until(
            async () => denied.messages,
            (rows) => rows.some((r) => r.type === 'error'),
          );
          assert.ok(!denied.messages.some((r) => r.type === 'frame'));
        }
        const active = await connect(id);
        await until(
          async () => active.messages,
          (rows) => rows.some((r) => r.type === 'frame'),
        );
        const commandId = randomUUID();
        active.socket.send(
          JSON.stringify({
            type: 'command',
            commandId,
            command: {
              type: 'browser.act',
              action: 'navigate',
              target: 'https://second.example.test/login',
            },
          }),
        );
        await until(
          async () => active.messages,
          (rows) =>
            rows.some((r) => r.type === 'result' && r.commandId === commandId),
        );
        assert.equal(await savedCount(), 0);
        active.socket.close();
        await new Promise((resolve) => active.socket.once('close', resolve));
        const resumed = await connect(id);
        await until(
          async () => resumed.messages,
          (rows) => rows.some((r) => r.type === 'frame'),
        );
        assert.equal(node.calls.get(`node-profile-open-${id}`), 1);
        node.restartOnAuthSave = true;
        resumed.socket.send(
          JSON.stringify({ type: 'complete', confirmedItems: [] }),
        );
        await until(
          async () => resumed.messages,
          (rows) => rows.some((r) => r.type === 'completed'),
        );
        assert.equal(
          resumed.messages.find((r) => r.type === 'completed').authStatus,
          'saved',
        );
        const state = await api(`/v1/node-profiles/${id}`);
        assert.equal(state.closed, true);
        assert.equal(state.saveStatus, 'saved');
        assert.equal(await savedCount(), 1);
        assert.equal(
          (
            await sql.query(
              'SELECT count(*)::int AS n FROM pr_identity_library',
            )
          ).rows[0].n,
          0,
        );
        const finished = await connect(id);
        await until(
          async () => finished.messages,
          (rows) => rows.some((r) => r.type === 'completed'),
        );
        assert.equal(await savedCount(), 1);
      });
      // 范围：提交保存后丢失连接，重连恢复原回执并关闭；延迟为协议夹具，不模拟实际磁盘耗时。
      await suite.test('保存期间断线后无需画面即可完成原保存', async () => {
        const id = await create();
        const before = await savedCount();
        const original = node.execute.bind(node);
        node.execute = (command) => {
          if (command.command.type === 'browser.auth.save')
            setTimeout(() => original(command), 250);
          else original(command);
        };
        try {
          const first = await connect(id);
          await until(
            async () => first.messages,
            (rows) => rows.some((r) => r.type === 'frame'),
          );
          first.socket.send(
            JSON.stringify({ type: 'complete', confirmedItems: [] }),
          );
          await until(savedCount, (n) => n === before + 1);
          first.socket.terminate();
          await until(
            async () =>
              (
                await sql.query(
                  "SELECT result FROM pr_commands WHERE kind='browser.auth.save' ORDER BY created_at DESC LIMIT 1",
                )
              ).rows[0],
            (row) => row.result?.operationStatus === 'SUCCEEDED',
          );
          const second = await connect(id);
          await until(
            async () => second.messages,
            (rows) => rows.some((r) => r.type === 'completed'),
          );
          assert.equal(
            second.messages.find((r) => r.type === 'completed').authStatus,
            'saved',
          );
          assert.equal(await savedCount(), before + 1);
          assert.equal((await api(`/v1/node-profiles/${id}`)).closed, true);
        } finally {
          node.execute = original;
        }
      });
      // 范围：保存明确未开始时保留会话并允许重新尝试；不模拟磁盘中途失败。
      await suite.test('保存失败后重连只重试确定未开始的命令', async () => {
        node.restartOnAuthSave = false;
        const id = await create();
        const first = await connect(id);
        await until(
          async () => first.messages,
          (rows) => rows.some((r) => r.type === 'frame'),
        );
        node.authSaveFailure = true;
        first.socket.send(
          JSON.stringify({ type: 'complete', confirmedItems: [] }),
        );
        await until(
          async () => first.messages,
          (rows) => rows.some((r) => r.code === 'AUTH_SAVE_FAILED'),
        );
        assert.equal((await api(`/v1/node-profiles/${id}`)).ready, true);
        node.authSaveFailure = false;
        const second = await connect(id);
        await until(
          async () => second.messages,
          (rows) => rows.some((r) => r.type === 'frame'),
        );
        second.socket.send(
          JSON.stringify({ type: 'complete', confirmedItems: [] }),
        );
        await until(
          async () => second.messages,
          (rows) => rows.some((r) => r.type === 'completed'),
        );
        assert.equal(
          (await api(`/v1/node-profiles/${id}`)).saveStatus,
          'saved',
        );
      });
      // 范围：主动不保存与过期关闭不派发保存；并非真实浏览器关闭验收。
      await suite.test('不保存关闭和授权到期', async () => {
        const before = await savedCount();
        const id = await create();
        const connection = await connect(id);
        await until(
          async () => connection.messages,
          (rows) => rows.some((r) => r.type === 'frame'),
        );
        connection.socket.send(
          JSON.stringify({ type: 'unable', reason: '不保存并关闭' }),
        );
        await until(
          async () => connection.messages,
          (rows) => rows.some((r) => r.type === 'completed'),
        );
        assert.equal((await api(`/v1/node-profiles/${id}`)).saveStatus, null);
        const expired = await create();
        await sql.query(
          "UPDATE pr_executions SET human_deadline_at=clock_timestamp()-interval '1 second' WHERE task_id=(SELECT task_id FROM pr_node_profiles WHERE id=$1)",
          [expired],
        );
        await until(
          () => api(`/v1/node-profiles/${expired}`),
          (value) => value.closed,
        );
        assert.equal(await savedCount(), before);
      });
      // 范围：关闭未确认仍占用同一维护会话；不把收到关闭请求当作资源已释放。
      await suite.test('关闭确认前保留容量，节点撤销终止维护', async () => {
        const id = await create();
        node.ignoreClose = true;
        await api(`/v1/node-profiles/${id}/close`, {});
        assert.equal((await api(`/v1/node-profiles/${id}`)).closed, false);
        assert.equal(
          (await api(path, { url: 'https://example.test/' })).id,
          id,
        );
        assert.equal((await api('/v1/nodes')).nodes[0].occupied, 1);
        node.ignoreClose = false;
        const closing = (
          await sql.query(
            "SELECT envelope FROM pr_commands WHERE kind='session.close' AND result IS NULL ORDER BY created_at DESC LIMIT 1",
          )
        ).rows[0];
        node.execute(closing.envelope);
        await until(
          () => api(`/v1/node-profiles/${id}`),
          (value) => value.closed,
        );
        const revoked = await create();
        await api(`/v1/nodes/${node.id}/revoke`, {});
        const state = await api(`/v1/node-profiles/${revoked}`);
        assert.equal(state.closing, true);
        assert.equal(state.saveStatus, null);
      });
    } finally {
      sockets.forEach((s) => s.terminate());
      node.close();
      await app.close();
      await sql.end();
      await admin.query(`DROP DATABASE ${name}`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  },
);
