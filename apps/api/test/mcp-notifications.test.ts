import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import pg from 'pg';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { canonical, digest } from '../src/domain.js';
import { buildApp } from '../src/app.js';
import type { ApiConfig } from '../src/config.js';
import {
  SimulatedNode,
  SimulatedWorker,
  until,
  PNG,
  PNG_HASH,
} from './fixture.js';
import { MockNotifications } from './notification-fixture.js';

/** 全部凭据仅用于回环协议夹具，每个调用方向使用独立凭据。 */
const ADMIN = 'mcp-test-admin-credential-at-least-32';
const WORKER = 'mcp-test-worker-credential-at-least-32';
const CLIENT = 'mcp-test-client-credential-at-least-32';
const OTHER = 'mcp-test-other-client-credential-at-least-32';
const DELIVERY = 'mcp-test-delivery-credential-at-least-32';
const VIEW = 'mcp-test-view-credential-at-least-32';
/** 业务断言由夹具提交，节点不会真的打开站点或证明页面内容。 */
const caseInput = (caseId: string) => ({
  caseId,
  platform: '协议测试',
  entry: 'https://fixture.invalid/',
  session: { mode: 'guest' as const },
  steps: [
    {
      type: 'verification' as const,
      url: 'https://fixture.invalid/',
      exec_order: 1,
      description: '检查页面',
      policy: [],
      expected: ['显示测试结果'],
    },
  ],
  cleanup: [],
});

// 范围：官方 MCP 客户端、真实 PostgreSQL/HTTP/WS 与模拟 cc-connect 的持久通知闭环；不代表飞书发送或真实浏览器业务验收。
test('MCP 与 HITL 通知完整链路', { timeout: 90_000 }, async (suite) => {
  const databaseUrl = process.env.PROOFRUN_TEST_DATABASE_URL;
  assert.ok(databaseUrl, '请设置独立测试 PostgreSQL 管理连接');
  const adminDb = new pg.Pool({ connectionString: databaseUrl });
  const name = `proofrun_mcp_${randomUUID().replaceAll('-', '')}`;
  await adminDb.query(`CREATE DATABASE ${name}`);
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  const sql = new pg.Pool({ connectionString: url.toString() });
  const root = await mkdtemp(join(tmpdir(), 'proofrun-mcp-'));
  const holder = createServer();
  await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve));
  const port = (holder.address() as { port: number }).port;
  await new Promise<void>((resolve) => holder.close(() => resolve()));
  const base = `http://127.0.0.1:${port}`;
  const mock = new MockNotifications(sql, DELIVERY, VIEW, () => base);
  await mock.start();
  const config: ApiConfig = {
    databaseUrl: url.toString(),
    adminToken: ADMIN,
    workerToken: WORKER,
    publicUrl: base,
    artifactDirectory: root,
    host: '127.0.0.1',
    port,
    workerLeaseMs: 5000,
    nodeLeaseMs: 5000,
    tickMs: 50,
    caseProfile: {
      environment: {
        id: 'fixture',
        nodePool: 'mcp-hitl',
        reuseAuth: false,
        allowIntervention: true,
      },
      budget: { timeoutMs: 60000, maxActions: 20 },
      executionMode: 'llm',
      evidenceKinds: ['DOM'],
    },
    integrations: {
      connections: [
        {
          id: 'mock-cc',
          url: mock.base,
          deliveryToken: DELIVERY,
          viewToken: VIEW,
          bindings: [
            { ref: 'qa', version: 1 },
            { ref: 'new-default', version: 2 },
          ],
        },
      ],
      clients: [
        {
          id: 'dev-agent',
          token: CLIENT,
          integrationId: 'mock-cc',
          bindingRefs: ['qa', 'new-default'],
          defaultBindingRef: 'qa',
        },
        {
          id: 'other-client',
          token: OTHER,
          integrationId: 'mock-cc',
          bindingRefs: ['qa'],
          defaultBindingRef: 'qa',
        },
      ],
    },
  };
  let app = await buildApp(config, { logger: false });
  await app.listen({ port, host: '127.0.0.1' });
  const clients: Client[] = [];
  const sockets: WebSocket[] = [];
  const workers: SimulatedWorker[] = [];
  let node: SimulatedNode | undefined;
  /** 关闭顺序保证客户端与后台任务均已结束，临时库不残留生产数据。 */
  suite.after(async () => {
    for (const socket of sockets) socket.terminate();
    for (const worker of workers) await worker.close();
    for (const client of clients) await client.close();
    node?.close();
    await app.close();
    await mock.app.close();
    await sql.end();
    await adminDb.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await adminDb.end();
    await rm(root, { recursive: true, force: true });
  });
  const connect = async (token = CLIENT) => {
    const client = new Client({
      name: 'proofrun-protocol-fixture',
      version: '1.0.0',
    });
    const transport = new StreamableHTTPClientTransport(
      new URL(`${base}/mcp`),
      { requestInit: { headers: { authorization: `Bearer ${token}` } } },
    );
    await client.connect(transport as unknown as Transport);
    clients.push(client);
    return client;
  };
  let client = await connect();
  const call = async (
    tool: string,
    input: Record<string, unknown> = {},
    caller = client,
  ) => {
    const result = await caller.callTool({
      name: `proofrun_${tool}`,
      arguments: input,
    });
    assert.ok(!result.isError, JSON.stringify(result));
    return result.structuredContent as any;
  };
  const api = async (path: string, body?: unknown, token = ADMIN) => {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = (await response.json()) as any;
    assert.ok(response.ok, `${response.status} ${JSON.stringify(data)}`);
    return data;
  };
  const events = async (caseId: string) =>
    (
      await sql.query(
        "SELECT * FROM pr_notification_outbox WHERE payload->>'caseId'=$1 ORDER BY created_at,sequence",
        [caseId],
      )
    ).rows;
  const delivered = async (caseId: string, type: string) =>
    until(
      async () =>
        (await events(caseId)).filter(
          (row) => row.payload.type === type && row.status === 'delivered',
        ),
      (rows) => rows.length > 0,
      12_000,
    );
  const start = async (caseId: string) => {
    await call('case_submit', {
      case: caseInput(caseId),
      notification: { bindingRef: 'qa', events: ['hitl', 'case.finished'] },
    });
    const execution = await until(
      async () =>
        (
          await api(
            '/v1/worker/claim',
            {
              type: 'worker.claim',
              workerId: randomUUID(),
              structuredSteps: true,
              stepBudgetVersion: 1,
              identityVersion: 1,
              profileTabsVersion: 1,
              executionPlanVersion: 1,
            },
            WORKER,
          )
        ).execution,
      (value) => !!value,
    );
    const worker = new SimulatedWorker(base, execution);
    workers.push(worker);
    await until(
      () =>
        api(`/v1/executions/${execution.id}`, undefined, execution.leaseToken),
      (value) => value.state === 'RUNNING',
    );
    return { execution, worker };
  };
  const requestHuman = (execution: any, revision = 0) =>
    api(`/v1/admin/executions/${execution.id}/intervene`, {
      type: 'execution.intervene',
      reason: '需要人工确认',
      items: ['确认测试环境'],
      controlRevision: revision,
    });
  const openLink = async (link: string) => {
    const parts = new URL(link).hash.split('/');
    const socket = new WebSocket(
      `${base.replace('http', 'ws')}/v1/hitl/connect`,
      { origin: base },
    );
    sockets.push(socket);
    const messages: any[] = [];
    socket.on('message', (data) => messages.push(JSON.parse(data.toString())));
    socket.on('error', () => {});
    await new Promise<void>((resolve) => socket.once('open', resolve));
    socket.send(
      JSON.stringify({
        type: 'authenticate',
        id: parts.at(-2),
        token: parts.at(-1),
      }),
    );
    return { socket, messages };
  };

  // 范围：工具发现、只读预检、原子幂等、归属隔离、默认绑定变更与服务离线；不验证模型能否正确编写验收标准。
  await suite.test('工具契约、原子提交和固定绑定', async () => {
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 7);
    assert.ok(
      tools.tools.every((tool) => tool.inputSchema && tool.outputSchema),
    );
    assert.equal((await call('capabilities_get')).caseProtocol, 'v2');
    const before = (await sql.query('SELECT count(*) FROM pr_tasks')).rows[0]!
      .count;
    assert.equal(
      (await call('case_validate', { case: caseInput('validate') })).executed,
      false,
    );
    assert.equal(
      (await sql.query('SELECT count(*) FROM pr_tasks')).rows[0]!.count,
      before,
    );
    const invalid = await client.callTool({
      name: 'proofrun_case_submit',
      arguments: { case: {} },
    });
    assert.equal(invalid.isError, true);
    const badIdentity = await client.callTool({
      name: 'proofrun_case_get',
      arguments: { caseId: 42 },
    });
    assert.equal(badIdentity.isError, true);
    assert.equal((badIdentity.structuredContent as any).effect, 'none');
    const input = {
      case: caseInput('idempotent'),
      source: { kind: 'linear', reference: 'TEST-1' },
    };
    const replies = await Promise.all([
      call('case_submit', input),
      call('case_submit', input),
    ]);
    assert.equal(replies.filter((r) => r.deduplicated).length, 1);
    config.integrations!.clients[0]!.defaultBindingRef = 'new-default';
    mock.unavailable = true;
    assert.equal((await call('case_submit', input)).bindingRef, 'qa');
    assert.equal(
      (await api('/v1/integrations/cases', input, CLIENT)).deduplicated,
      true,
    );
    const unavailable = await client.callTool({
      name: 'proofrun_case_submit',
      arguments: { case: caseInput('offline-new') },
    });
    assert.equal(unavailable.isError, true);
    assert.equal((unavailable.structuredContent as any).effect, 'none');
    assert.equal(
      (
        await sql.query(
          "SELECT id FROM pr_tasks WHERE id='case-v2-offline-new'",
        )
      ).rowCount,
      0,
    );
    const changed = await client.callTool({
      name: 'proofrun_case_submit',
      arguments: { ...input, notification: { bindingRef: 'new-default' } },
    });
    assert.equal(changed.isError, true);
    const other = await connect(OTHER);
    assert.equal(
      (
        await other.callTool({
          name: 'proofrun_case_get',
          arguments: { caseId: 'idempotent' },
        })
      ).isError,
      true,
    );
    assert.equal(
      (await other.callTool({ name: 'proofrun_case_submit', arguments: input }))
        .isError,
      true,
    );
    mock.unavailable = false;
    await call('case_rerun', { caseId: 'idempotent', newCaseId: 'rerun' });
    assert.equal(
      (
        await sql.query(
          "SELECT context->>'bindingRef' AS ref FROM pr_integration_cases WHERE case_id='rerun'",
        )
      ).rows[0]!.ref,
      'qa',
    );
    await call('case_cancel', { caseId: 'idempotent' });
    await call('case_cancel', { caseId: 'rerun' });
    config.integrations!.clients[0]!.defaultBindingRef = 'qa';
    assert.equal(
      (
        await fetch(`${base}/mcp`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${CLIENT}`,
            origin: 'https://untrusted.invalid',
            'content-type': 'application/json',
          },
          body: '{}',
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${base}/mcp`, {
          headers: { authorization: `Bearer ${ADMIN}` },
        })
      ).status,
      401,
    );
  });

  // 范围：真实事务触发通知、丢失入箱确认、重启后重试、回读、人工交还和终态；画面与人工作用由协议夹具模拟。
  await suite.test(
    'HITL 入箱确认丢失和重启恢复，人工完成撤销链接',
    async () => {
      node = new SimulatedNode(base, 'mcp-hitl', 2);
      node.fullProfile = true;
      await node.pair(ADMIN);
      await until(
        () => api('/v1/nodes'),
        (value) => value.nodes.some((n: any) => n.id === node!.id && n.online),
      );
      const { execution, worker } = await start('human');
      mock.dropNextAck = true;
      await requestHuman(execution);
      await until(
        () =>
          sql.query(
            "SELECT * FROM mock_notification_inbox WHERE payload->>'caseId'='human'",
          ),
        (value) => value.rowCount === 1,
      );
      await worker.close();
      await client.close();
      await app.close();
      app = await buildApp(config, { logger: false });
      await app.listen({ port, host: '127.0.0.1' });
      client = await connect();
      // 测试主动停止 worker，原执行随后按租约终止；此处验证持久补发，新人工交互使用新的执行。
      const rows = await until(
        () => events('human'),
        (value) => value.some((row) => row.status === 'delivered'),
        12_000,
      );
      const inbox = (
        await sql.query(
          "SELECT hits FROM mock_notification_inbox WHERE payload->>'caseId'='human' ORDER BY hits DESC",
        )
      ).rows;
      assert.ok(inbox.some((row) => row.hits >= 2));
      assert.ok(
        rows.every((row) => !JSON.stringify(row.payload).includes('/#/hitl/')),
      );
      await call('case_cancel', { caseId: 'human' });
      node.close();
      node = new SimulatedNode(base, 'mcp-hitl', 2);
      node.fullProfile = true;
      await node.pair(ADMIN);
      await until(
        () => api('/v1/nodes'),
        (value) => value.nodes.some((n: any) => n.id === node!.id && n.online),
      );
      const next = await start('human-complete');
      await requestHuman(next.execution);
      const [requested] = await delivered('human-complete', 'hitl.requested');
      const view = await api(
        `/v1/integrations/notifications/${requested!.event_id}/view`,
        undefined,
        VIEW,
      );
      assert.ok(view.action.url.includes('/#/hitl/'));
      assert.equal(
        (
          await fetch(
            `${base}/v1/integrations/notifications/${requested!.event_id}/view`,
            { headers: { authorization: `Bearer ${CLIENT}` } },
          )
        ).status,
        401,
      );
      const model = await call('case_get', { caseId: 'human-complete' });
      assert.ok(!JSON.stringify(model).includes(view.action.url));
      const session = await openLink(view.action.url);
      await until(
        () => session.messages,
        (messages) => messages.some((m) => m.type === 'state'),
      );
      await api(
        `/v1/executions/${next.execution.id}/control`,
        {
          type: 'execution.control',
          action: 'acknowledge',
          controlRevision: 1,
        },
        next.execution.leaseToken,
      );
      await until(
        () => session.messages,
        (messages) => messages.some((m) => m.type === 'frame'),
      );
      session.socket.send(
        JSON.stringify({ type: 'complete', confirmedItems: [0] }),
      );
      await until(
        () => session.messages,
        (messages) => messages.some((m) => m.type === 'completed'),
      );
      await delivered('human-complete', 'hitl.resolved');
      const old = await api(
        `/v1/integrations/notifications/${requested!.event_id}/view`,
        undefined,
        VIEW,
      );
      assert.equal(old.state, 'RESOLVED');
      assert.equal(old.action, null);
      assert.equal(
        (await call('case_get', { caseId: 'human-complete' })).result.status,
        'RUNNING',
      );
      await next.worker.close();
      await call('case_cancel', { caseId: 'human-complete' });
      await delivered('human-complete', 'case.finished');
    },
  );

  // 范围：同一人工请求的链接轮换、过期回读无副作用、取消与远端发送不确定；不验证真实飞书卡片更新。
  await suite.test('链接轮换稳定身份与 unknown 回执', async () => {
    const { execution, worker } = await start('rotate');
    await requestHuman(execution);
    const [requested] = await delivered('rotate', 'hitl.requested');
    const first = await api(
      `/v1/integrations/notifications/${requested!.event_id}/view`,
      undefined,
      VIEW,
    );
    const stable = first.aggregate.id;
    await sql.query(
      "UPDATE pr_interventions SET expires_at=clock_timestamp()-interval '1 second' WHERE execution_id=$1",
      [execution.id],
    );
    const refreshed = await until(
      () =>
        api(
          `/v1/integrations/notifications/${requested!.event_id}/view`,
          undefined,
          VIEW,
        ),
      (v) => !!v.action && v.action.url !== first.action.url,
    );
    assert.equal(refreshed.aggregate.id, stable);
    assert.ok(refreshed.aggregate.sequence > first.aggregate.sequence);
    const stale = await openLink(first.action.url);
    await until(
      () => stale.messages,
      (messages) => messages.some((m) => m.code === 'HITL_INVALID'),
    );
    mock.deliveryStatus = 'unknown';
    await worker.close();
    await call('case_cancel', { caseId: 'rotate' });
    await until(
      () => events('rotate'),
      (rows) => rows.some((r) => r.status === 'unknown'),
      10_000,
    );
    const end = await api(
      `/v1/integrations/notifications/${requested!.event_id}/view`,
      undefined,
      VIEW,
    );
    assert.equal(end.action, null);
    assert.equal(end.state, 'CLOSED');
    mock.deliveryStatus = 'delivered';
  });

  // 范围：业务事务回滚不留下通知、服务端退避不停止 worker 续租；服务故障为 HTTP 夹具，不代表飞书可用性。
  await suite.test('事务回滚与通知服务不可用恢复', async () => {
    const { execution, worker } = await start('remote-retry');
    mock.unavailable = true;
    await requestHuman(execution);
    await until(
      () => events('remote-retry'),
      (rows) => rows.some((r) => r.status === 'retrying'),
    );
    const before = (await events('remote-retry')).length;
    const tx = await sql.connect();
    try {
      await tx.query('BEGIN');
      await tx.query(
        "UPDATE pr_executions SET control_mode='HUMAN' WHERE id=$1",
        [execution.id],
      );
      await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
      assert.equal(
        (
          await tx.query(
            "SELECT count(*)::int AS n FROM pr_notification_outbox WHERE payload->>'caseId'='remote-retry'",
          )
        ).rows[0]!.n,
        before + 1,
      );
      await tx.query('ROLLBACK');
    } finally {
      tx.release();
    }
    assert.equal((await events('remote-retry')).length, before);
    assert.equal(
      (
        await api(
          `/v1/executions/${execution.id}`,
          undefined,
          execution.leaseToken,
        )
      ).controlMode,
      'REQUESTED',
    );
    mock.unavailable = false;
    const [row] = await delivered('remote-retry', 'hitl.requested');
    const first = await api(
      `/v1/integrations/notifications/${row!.event_id}/view`,
      undefined,
      VIEW,
    );
    const second = await api(
      `/v1/integrations/notifications/${row!.event_id}/view`,
      undefined,
      VIEW,
    );
    assert.deepEqual(second, first);
    assert.equal((await events('remote-retry')).length, before);
    await worker.close();
    await call('case_cancel', { caseId: 'remote-retry' });
  });

  // 范围：人工无法执行和等待超时均撤销处理链接并产生关闭通知；操作和浏览器仍为协议模拟。
  await suite.test('人工无法执行与等待超时', async () => {
    const { execution, worker } = await start('unable');
    await requestHuman(execution);
    const [row] = await delivered('unable', 'hitl.requested');
    const view = await api(
      `/v1/integrations/notifications/${row!.event_id}/view`,
      undefined,
      VIEW,
    );
    const session = await openLink(view.action.url);
    await until(
      () => session.messages,
      (messages) => messages.some((m) => m.type === 'state'),
    );
    await api(
      `/v1/executions/${execution.id}/control`,
      { type: 'execution.control', action: 'acknowledge', controlRevision: 1 },
      execution.leaseToken,
    );
    await until(
      () => session.messages,
      (messages) => messages.some((m) => m.type === 'frame'),
    );
    await worker.close();
    session.socket.send(
      JSON.stringify({ type: 'unable', reason: '测试账号无法使用' }),
    );
    await until(
      () => session.messages,
      (messages) => messages.some((m) => m.type === 'unable'),
    );
    await delivered('unable', 'hitl.closed');
    const result = await call('case_get', { caseId: 'unable' });
    assert.equal(result.result.executionOutcome.category, 'HUMAN_UNEXECUTABLE');
    assert.equal(
      (
        await api(
          `/v1/integrations/notifications/${row!.event_id}/view`,
          undefined,
          VIEW,
        )
      ).action,
      null,
    );
    const timed = await start('human-timeout');
    await requestHuman(timed.execution);
    await timed.worker.close();
    await sql.query(
      "UPDATE pr_executions SET human_deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [timed.execution.id],
    );
    await delivered('human-timeout', 'hitl.closed');
    const end = await call('case_get', { caseId: 'human-timeout' });
    assert.ok(!['RUNNING', 'QUEUED'].includes(end.result.status));
    assert.equal(end.interventions[0].state, 'CLOSED');
  });

  // 范围：已交付证据的归属、MCP 图片/JSON、摘要与大小限制，以及 FAILED 结果不作为工具错误；证据与报告直接写入夹具，不证明浏览器采集或真实验收失败。
  await suite.test('证据读取和测试失败的工具语义', async () => {
    const source = (
      await sql.query(
        "SELECT c.* FROM pr_commands c JOIN pr_executions e ON e.id=c.execution_id WHERE e.task_id='case-v2-human-complete' LIMIT 1",
      )
    ).rows[0]!;
    const jsonId = randomUUID();
    const imageId = randomUUID();
    const content = { text: '模拟页面没有预期文字' };
    for (const item of [
      {
        id: jsonId,
        kind: 'DOM',
        hash: digest(canonical(content)),
        content,
        size: Buffer.byteLength(canonical(content)),
      },
      {
        id: imageId,
        kind: 'SCREENSHOT',
        hash: PNG_HASH,
        content: null,
        size: PNG.length,
      },
    ]) {
      await sql.query(
        "INSERT INTO pr_artifacts(id,node_id,execution_id,session_id,command_id,kind,hash,state,size,content) VALUES($1,$2,$3,$4,$5,$6,$7,'AVAILABLE',$8,$9)",
        [
          item.id,
          source.node_id,
          source.execution_id,
          source.session_id,
          source.id,
          item.kind,
          item.hash,
          item.size,
          item.content,
        ],
      );
    }
    await writeFile(join(root, imageId), PNG);
    const report = {
      protocolVersion: '0.1',
      taskId: 'case-v2-human-complete',
      lifecycle: 'COMPLETED',
      executionDisposition: 'EXECUTED',
      verdict: 'FAILED',
      summary: '模拟失败结果',
      criteria: [
        {
          criterionId: 'step-1-expected-1',
          verdict: 'FAILED',
          summary: '模拟证据',
          evidenceRefs: [jsonId],
        },
      ],
      artifacts: [
        {
          id: jsonId,
          kind: 'DOM',
          sha256: digest(canonical(content)),
          url: `${base}/v1/artifacts/${jsonId}`,
        },
        {
          id: imageId,
          kind: 'SCREENSHOT',
          sha256: PNG_HASH,
          url: `${base}/v1/artifacts/${imageId}`,
        },
      ],
    };
    await sql.query(
      "UPDATE pr_tasks SET state='COMPLETED',report=$1 WHERE id='case-v2-human-complete'",
      [report],
    );
    const result = await call('case_get', { caseId: 'human-complete' });
    assert.equal(result.result.result.outcome, 'FAILED');
    const json = await call('evidence_read', {
      caseId: 'human-complete',
      artifactId: jsonId,
    });
    assert.equal(json.sha256, digest(canonical(content)));
    const image = await client.callTool({
      name: 'proofrun_evidence_read',
      arguments: { caseId: 'human-complete', artifactId: imageId },
    });
    assert.ok(
      (image.content as any[]).some(
        (item) => item.type === 'image' && item.data === PNG.toString('base64'),
      ),
    );
    assert.equal(
      (
        await client.callTool({
          name: 'proofrun_evidence_read',
          arguments: { caseId: 'idempotent', artifactId: imageId },
        })
      ).isError,
      true,
    );
    await sql.query('UPDATE pr_artifacts SET hash=$2 WHERE id=$1', [
      jsonId,
      '0'.repeat(64),
    ]);
    const badHash = await client.callTool({
      name: 'proofrun_evidence_read',
      arguments: { caseId: 'human-complete', artifactId: jsonId },
    });
    assert.equal(
      (badHash.structuredContent as any).code,
      'EVIDENCE_HASH_MISMATCH',
    );
    await sql.query('UPDATE pr_artifacts SET size=$2 WHERE id=$1', [
      imageId,
      9 * 1024 * 1024,
    ]);
    const tooLarge = await client.callTool({
      name: 'proofrun_evidence_read',
      arguments: { caseId: 'human-complete', artifactId: imageId },
    });
    assert.equal(
      (tooLarge.structuredContent as any).code,
      'EVIDENCE_TOO_LARGE',
    );
  });

  // 范围：双跑取消后的整例完成事件只生成一次，重复取消不生成重复事件；不评价两执行模式的验收质量。
  await suite.test('双跑整例终态去重与绑定事务回滚', async () => {
    config.caseProfile!.executionMode = 'parallel';
    await call('case_submit', {
      case: caseInput('parallel'),
      notification: { bindingRef: 'qa', events: ['hitl', 'case.finished'] },
    });
    const cancelled = await call('case_cancel', { caseId: 'parallel' });
    assert.ok(
      cancelled.comparison.arms.every((arm: any) => arm.status === 'CANCELLED'),
    );
    await call('case_cancel', { caseId: 'parallel' });
    assert.equal(
      (await events('parallel')).filter(
        (e) => e.payload.type === 'case.finished',
      ).length,
      1,
    );
    // 通过管理接口创建的 case 不能被集成接口占为己有。
    await api('/v2/cases', [caseInput('admin-owned')]);
    assert.equal(
      (
        await client.callTool({
          name: 'proofrun_case_submit',
          arguments: { case: caseInput('admin-owned') },
        })
      ).isError,
      true,
    );
    assert.equal(
      (
        await sql.query(
          "SELECT * FROM pr_integration_cases WHERE case_id='admin-owned'",
        )
      ).rowCount,
      0,
    );
    await api('/v2/cases/admin-owned/cancel', {});
    config.caseProfile!.executionMode = 'llm';
  });
});
