import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  validateMcpTaskResult,
  type McpTaskResult,
  type VerificationCaseV2,
} from '@proofrun/contracts';
import { buildApp } from '../src/app.js';
import type { ApiConfig } from '../src/config.js';
import { canonical, digest } from '../src/domain.js';
import {
  loadPublicCredentials,
  validatePublicCredentials,
  PUBLIC_SCOPES,
  type PublicCredential,
} from '../src/modules/public-execution/auth.js';

/** 仅测试凭据，无部署权限；客户端与平台通过真实 HTTP/JSON-RPC 通信。 */
const TOKENS = {
  full: 'task-mcp-fixture-full',
  other: 'task-mcp-fixture-other',
  read: 'task-mcp-fixture-read',
  browser: 'task-mcp-fixture-browser',
};
const ADMIN = 'task-mcp-fixture-admin';
const DATABASE_URL = process.env.PROOFRUN_TEST_DATABASE_URL;
const credentials: PublicCredential[] = Object.entries(TOKENS).map(
  ([kind, token]) => ({
    principalId: kind === 'other' ? 'other' : 'upstream',
    tokenSha256: digest(token),
    channels: kind === 'browser' ? ['browser'] : ['browser', 'verification'],
    scopes: kind === 'read' ? ['runs:read'] : [...PUBLIC_SCOPES],
  }),
);

/** 最小结构化业务输入；不会启动浏览器、模型或真实账号。 */
function example(caseId: string): VerificationCaseV2 {
  return {
    caseId,
    platform: 'MCP 测试夹具',
    entry: 'https://example.test',
    session: { mode: 'guest' },
    steps: [
      {
        stepId: 'check',
        type: 'verification',
        url: 'https://example.test',
        exec_order: 1,
        description: '检查结果',
        policy: [],
        expected: ['标题正确', '结果存在'],
      },
    ],
    cleanup: [],
  };
}
/** 同时检查 SDK 解码和共享输出契约，避免仅断言数据库事实。 */
type ResultData = {
  [K in McpTaskResult['kind']]: Extract<McpTaskResult, { kind: K }>['data'];
};
async function success<K extends keyof ResultData>(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  kind: K,
): Promise<ResultData[K]> {
  const response = await client.callTool({ name, arguments: args });
  assert.ok(!response.isError, JSON.stringify(response));
  assert.ok(
    validateMcpTaskResult(response.structuredContent),
    JSON.stringify(validateMcpTaskResult.errors),
  );
  assert.equal(response.structuredContent.kind, kind);
  return response.structuredContent.data as ResultData[K];
}
/** 工具业务错误必须是 isError，不能伪装为验证 FAILED。 */
async function failure(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  code: string,
) {
  const response = await client.callTool({ name, arguments: args });
  assert.equal(response.isError, true, JSON.stringify(response));
  assert.equal(
    (response.structuredContent as Record<string, unknown>)?.code,
    code,
    JSON.stringify(response),
  );
}

// 范围：配置文件权限、固定权限集和摘要唯一性；不验证实际密钥生成或线上部署。
test('MCP 凭据配置拒绝明文、重复摘要及不安全文件权限', async () => {
  assert.throws(() => validatePublicCredentials([]));
  assert.throws(() =>
    validatePublicCredentials([{ ...credentials[0], token: 'secret' }]),
  );
  assert.throws(() =>
    validatePublicCredentials([credentials[0], credentials[0]]),
  );
  assert.throws(() =>
    validatePublicCredentials([
      { ...credentials[0], scopes: ['executions:control'] },
    ]),
  );
  const root = await mkdtemp(join(tmpdir(), 'proofrun-mcp-auth-'));
  try {
    const path = join(root, 'credentials.json');
    await writeFile(path, JSON.stringify(credentials), { mode: 0o600 });
    assert.deepEqual(loadPublicCredentials(path), credentials);
    await chmod(path, 0o644);
    assert.throws(() => loadPublicCredentials(path));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 范围：真实 PostgreSQL 事务、MCP SDK、HTTP 与原服务复用；证据/报告由夹具注入，不属于真实浏览器或业务验收。
test(
  '两套任务 MCP 的发现、归属、原子重试、精确运行和证据集成',
  { timeout: 120_000 },
  async (suite) => {
    assert.ok(
      DATABASE_URL,
      '请设置独立测试 PostgreSQL 的 PROOFRUN_TEST_DATABASE_URL',
    );
    const admin = new pg.Pool({ connectionString: DATABASE_URL });
    const name = `proofrun_mcp_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(DATABASE_URL);
    url.pathname = `/${name}`;
    const sql = new pg.Client({ connectionString: url.toString() });
    await sql.connect();
    const root = await mkdtemp(join(tmpdir(), 'proofrun-mcp-'));
    const config: ApiConfig = {
      databaseUrl: url.toString(),
      adminToken: ADMIN,
      workerToken: 'task-mcp-fixture-worker',
      publicUrl: 'http://localhost',
      artifactDirectory: root,
      host: '127.0.0.1',
      port: 0,
      workerLeaseMs: 15000,
      nodeLeaseMs: 20000,
      tickMs: 1000,
      publicCredentials: credentials,
      caseProfile: {
        environment: { id: 'fixture', nodePool: 'fixture' },
        budget: { timeoutMs: 60000, maxActions: 20 },
        executionMode: 'llm',
        evidenceKinds: ['DOM'],
      },
    };
    let app = await buildApp(config, { logger: false });
    let address = await app.listen({ host: '127.0.0.1', port: 0 });
    const clients: Client[] = [];
    const connect = async (
      channel: 'browser' | 'verification',
      token = TOKENS.full,
    ) => {
      const client = new Client({
        name: 'proofrun-integration',
        version: '1.0.0',
      });
      clients.push(client);
      const transport = new StreamableHTTPClientTransport(
        new URL(`/mcp/${channel}`, address),
        { requestInit: { headers: { authorization: `Bearer ${token}` } } },
      );
      await client.connect(transport as Parameters<Client['connect']>[0]);
      return client;
    };
    const http = async (
      path: string,
      body?: object,
      token = TOKENS.full,
      extra: Record<string, string> = {},
    ) =>
      app.inject({
        method: body === undefined ? 'GET' : 'POST',
        url: path,
        headers: {
          host: 'localhost',
          authorization: `Bearer ${token}`,
          ...extra,
        },
        ...(body === undefined ? {} : { payload: body }),
      });
    let browser: Client;
    let verification: Client;
    let other: Client;
    let readonly: Client;
    const submitted = {
      requestId: 'request-main',
      cases: [example('alpha'), example('beta')],
    };
    let initial: Extract<McpTaskResult, { kind: 'submission' }>['data'];
    let browserRun = '';
    try {
      browser = await connect('browser');
      verification = await connect('verification');
      other = await connect('verification', TOKENS.other);
      readonly = await connect('verification', TOKENS.read);
      // 范围：发现与调用两处都授权，管理员不能隐式访问公共入口；不验证 OAuth 或外部执行。
      await suite.test(
        '两套目录与 scope 隔离，公开契约不泄漏内部工具',
        async () => {
          const bt = await browser.listTools();
          const vt = await verification.listTools();
          assert.equal(bt.tools.length, 17);
          assert.equal(vt.tools.length, 16);
          for (const [tools, prefix] of [
            [bt.tools, 'browser_'],
            [vt.tools, 'verification_'],
          ] as const)
            for (const tool of tools) {
              assert.ok(tool.name.startsWith(prefix));
              assert.ok(tool.inputSchema);
              assert.ok(tool.outputSchema);
              assert.ok(!JSON.stringify(tool.inputSchema).includes('$ref'));
            }
          const rt = await readonly.listTools();
          assert.ok(
            !rt.tools.some(
              (t) => t.name.includes('submit') || t.name.includes('evidence'),
            ),
          );
          await failure(
            readonly,
            'verification_submit_cases',
            submitted,
            'SCOPE_FORBIDDEN',
          );
          await failure(
            browser,
            'verification_get_capabilities',
            {},
            'TOOL_NOT_FOUND',
          );
          assert.equal(
            (await http('/v3/browser/capabilities', undefined, ADMIN))
              .statusCode,
            401,
          );
          assert.equal(
            (
              await http(
                '/v3/verification/capabilities',
                undefined,
                TOKENS.browser,
              )
            ).statusCode,
            403,
          );
          assert.equal(
            (
              await http('/v3/browser/capabilities', undefined, TOKENS.full, {
                origin: 'https://hostile.test',
              })
            ).statusCode,
            403,
          );
          assert.equal(
            (
              await http('/v3/browser/capabilities', undefined, TOKENS.full, {
                host: 'hostile.test',
              })
            ).statusCode,
            403,
          );
          const caps = await success(
            verification,
            'verification_get_capabilities',
            {},
            'capabilities',
          );
          assert.deepEqual(caps.supportedExecutors, ['builtin', 'external']);
          assert.ok(caps.unchecked.length);
          assert.ok(
            caps.capabilities.some(
              (c) => c.id === 'execution.external' && c.implemented === true,
            ),
          );
          const resource = await verification.readResource({
            uri: 'proofrun://schemas/case-v2',
          });
          assert.ok('text' in resource.contents[0]!);
        },
      );
      // 范围：预检编译、结构错误及未开放参数拒绝，无任务/归属/回执写入；不证明目标环境可执行。
      await suite.test(
        '预检只读，编译计划可见且拒绝未知 executor 和浏览器会话覆盖',
        async () => {
          const before = (
            await sql.query('SELECT count(*)::int AS n FROM pr_tasks')
          ).rows[0].n;
          const preview = await success(
            verification,
            'verification_validate_cases',
            submitted,
            'validation',
          );
          assert.equal(preview.valid, true);
          assert.equal(preview.executionPreview.length, 2);
          assert.ok(preview.executionPreview[0]!.stepBudget);
          const invalid = await success(
            verification,
            'verification_validate_cases',
            { ...submitted, cases: [{ ...example('invalid'), steps: [] }] },
            'validation',
          );
          assert.equal(invalid.valid, false);
          assert.ok(invalid.errors.length);
          const actions = config.caseProfile!.budget.maxActions;
          try {
            config.caseProfile!.budget.maxActions = 10001;
            await failure(
              browser,
              'browser_task_submit',
              {
                taskKey: 'budget-rejected',
                url: 'https://example.test',
                objective: '检查预算',
              },
              'INVALID_TASK',
            );
          } finally {
            config.caseProfile!.budget.maxActions = actions;
          }
          await failure(
            verification,
            'verification_submit_cases',
            { ...submitted, executor: { kind: 'unknown' } },
            'INVALID_INPUT',
          );
          await failure(
            browser,
            'browser_task_submit',
            {
              taskKey: 'blocked',
              url: 'https://example.test',
              objective: '检查',
              session: { mode: 'guest' },
            },
            'INVALID_INPUT',
          );
          assert.equal(
            (await sql.query('SELECT count(*)::int AS n FROM pr_tasks')).rows[0]
              .n,
            before,
          );
          assert.equal(
            (await sql.query('SELECT count(*)::int AS n FROM pr_public_calls'))
              .rows[0].n,
            0,
          );
        },
      );
      // 范围：并发调用冻结一次回执，跨协议读取相同事实及跨 principal 隔离；不启动 worker。
      await suite.test(
        '并发提交幂等、HTTP/MCP 同源、Case 归属不能抢占',
        async () => {
          const replies = await Promise.all([
            success(
              verification,
              'verification_submit_cases',
              submitted,
              'submission',
            ),
            success(
              verification,
              'verification_submit_cases',
              submitted,
              'submission',
            ),
          ]);
          initial = replies[0]!;
          assert.deepEqual(replies[0], replies[1]);
          const replay = await http('/v3/verification/requests', submitted);
          assert.equal(replay.statusCode, 202, replay.body);
          assert.deepEqual(replay.json().data, initial);
          assert.equal(
            (await sql.query('SELECT count(*)::int AS n FROM pr_tasks')).rows[0]
              .n,
            2,
          );
          await failure(
            verification,
            'verification_submit_cases',
            { ...submitted, title: 'changed' },
            'IDEMPOTENCY_CONFLICT',
          );
          await failure(
            other,
            'verification_get_request',
            { requestId: submitted.requestId },
            'RESOURCE_NOT_FOUND',
          );
          await failure(
            other,
            'verification_submit_cases',
            { requestId: 'other-claim', cases: [example('alpha')] },
            'RESOURCE_CONFLICT',
          );
          assert.equal(
            (
              await sql.query(
                "SELECT count(*)::int AS n FROM pr_verification_requests WHERE request_id='other-claim'",
              )
            ).rows[0].n,
            0,
          );
          const shared = await success(
            verification,
            'verification_submit_cases',
            { requestId: 'request-share', cases: [example('alpha')] },
            'submission',
          );
          assert.equal(shared.runs[0]!.origin, 'reused');
          const b = await success(
            browser,
            'browser_task_submit',
            {
              taskKey: 'browser-one',
              url: 'https://example.test',
              objective: '读取标题',
            },
            'submission',
          );
          browserRun = b.runs[0]!.runId;
          const run = await success(
            browser,
            'browser_task_get',
            { runId: browserRun },
            'run',
          );
          assert.equal(run.reportStatus, null);
          assert.equal(run.criteriaCounts, null);
          await failure(
            verification,
            'verification_get_run',
            { runId: browserRun },
            'RESOURCE_NOT_FOUND',
          );
          const br = await http(`/v3/runs/${browserRun}`);
          assert.equal(br.statusCode, 200, br.body);
          assert.equal(br.json().data.taskKind, 'browser');
          assert.equal(
            (await http(`/v3/runs/${browserRun}?principalId=other`)).statusCode,
            400,
          );
        },
      );
      // 范围：在回执最后写入处注入数据库失败，验证任务、成员、归属全部回滚；不模拟 PostgreSQL 进程崩溃。
      await suite.test(
        '回执落库失败不能遗留任务或归属，恢复后可安全重试',
        async () => {
          await sql.query(
            `CREATE FUNCTION fixture_reject_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.call_key='request-rollback' THEN RAISE EXCEPTION 'fixture failure'; END IF; RETURN NEW; END $$`,
          );
          await sql.query(
            'CREATE TRIGGER fixture_receipt BEFORE INSERT ON pr_public_calls FOR EACH ROW EXECUTE FUNCTION fixture_reject_receipt()',
          );
          const input = {
            requestId: 'request-rollback',
            cases: [example('rollback')],
          };
          try {
            const response = await http('/v3/verification/requests', input);
            assert.equal(response.statusCode, 503, response.body);
            assert.equal(response.json().code, 'SERVICE_UNAVAILABLE');
            assert.ok(!response.body.includes('fixture failure'));
            for (const [table, column, id] of [
              ['pr_tasks', 'id', 'case-v2-rollback'],
              ['pr_verification_requests', 'request_id', 'request-rollback'],
              ['pr_public_owners', 'resource_id', 'case-v2-rollback'],
              ['pr_public_calls', 'call_key', 'request-rollback'],
            ]) {
              assert.equal(
                (
                  await sql.query(
                    `SELECT count(*)::int AS n FROM ${table} WHERE ${column}=$1`,
                    [id],
                  )
                ).rows[0].n,
                0,
              );
            }
          } finally {
            await sql.query('DROP TRIGGER fixture_receipt ON pr_public_calls');
            await sql.query('DROP FUNCTION fixture_reject_receipt()');
          }
          assert.equal(
            (
              await success(
                verification,
                'verification_submit_cases',
                input,
                'submission',
              )
            ).runs[0]!.origin,
            'created',
          );
        },
      );
      // 范围：成员版本、来源身份和批次回滚；取消仅作用于明确 runId，重试不会改绑请求。
      await suite.test(
        '重跑原子替换，旧提交回执冻结，取消不会误伤最新运行',
        async () => {
          const request = await success(
            verification,
            'verification_get_request',
            { requestId: submitted.requestId },
            'request',
          );
          const op = randomUUID();
          const sourceRun = initial.runs.find(
            (r) => r.caseId === 'alpha',
          )!.runId;
          const input = {
            requestId: submitted.requestId,
            operationId: op,
            expectedRequestRevision: request.requestRevision,
            items: [
              {
                caseId: 'alpha',
                sourceRunId: sourceRun,
                runKey: 'alpha-rerun',
              },
            ],
          };
          const broken = {
            ...input,
            operationId: randomUUID(),
            items: [
              ...input.items,
              { caseId: 'beta', sourceRunId: sourceRun, runKey: 'invalid' },
            ],
          };
          await failure(
            verification,
            'verification_rerun_cases',
            broken,
            'REQUEST_REVISION_CONFLICT',
          );
          assert.equal(
            (
              await sql.query(
                "SELECT count(*)::int AS n FROM pr_tasks WHERE id LIKE 'case-run-%'",
              )
            ).rows[0].n,
            0,
          );
          const rerun = await success(
            verification,
            'verification_rerun_cases',
            input,
            'operation',
          );
          assert.deepEqual(
            await success(
              verification,
              'verification_rerun_cases',
              input,
              'operation',
            ),
            rerun,
          );
          await failure(
            verification,
            'verification_rerun_cases',
            { ...input, operationId: randomUUID() },
            'REQUEST_REVISION_CONFLICT',
          );
          assert.deepEqual(
            await success(
              verification,
              'verification_submit_cases',
              submitted,
              'submission',
            ),
            initial,
          );
          const after = await success(
            verification,
            'verification_get_request',
            { requestId: submitted.requestId },
            'request',
          );
          assert.notEqual(after.requestRevision, request.requestRevision);
          const newRun = rerun.runs![0]!.runId;
          const cancel = {
            runId: sourceRun,
            operationId: randomUUID(),
            reason: 'fixture cancel',
          };
          const result = await success(
            verification,
            'verification_cancel_run',
            cancel,
            'operation',
          );
          assert.deepEqual(result.affectedRequests, ['request-share']);
          assert.deepEqual(
            await success(
              verification,
              'verification_operation_get',
              { operationId: cancel.operationId },
              'operation',
            ),
            result,
          );
          assert.deepEqual(
            await success(
              verification,
              'verification_cancel_run',
              cancel,
              'operation',
            ),
            result,
          );
          await failure(
            verification,
            'verification_cancel_run',
            { ...cancel, runId: newRun },
            'IDEMPOTENCY_CONFLICT',
          );
          await failure(
            other,
            'verification_operation_get',
            { operationId: cancel.operationId },
            'RESOURCE_NOT_FOUND',
          );
          assert.equal(
            (
              await success(
                verification,
                'verification_get_run',
                { runId: sourceRun },
                'run',
              )
            ).status,
            'CANCELLED',
          );
          assert.equal(
            (
              await success(
                verification,
                'verification_get_run',
                { runId: newRun },
                'run',
              )
            ).status,
            'QUEUED',
          );
          assert.equal(
            (
              await http(
                `/v3/runs/${newRun}/cancel`,
                { operationId: randomUUID() },
                TOKENS.read,
              )
            ).statusCode,
            403,
          );
        },
      );
      // 范围：并发数量超过数据库池容量，提交与重跑复用事务连接；不测生产吞吐或多实例调度。
      await suite.test(
        '超过连接池容量的并发提交和重跑不会相互等待池连接',
        { timeout: 15000 },
        async () => {
          const inputs = Array.from({ length: 24 }, (_, i) => ({
            requestId: `load-${i}`,
            cases: [example(`load-${i}`)],
          }));
          const submissions = await Promise.all(
            inputs.map((input) => http('/v3/verification/requests', input)),
          );
          for (const response of submissions)
            assert.equal(response.statusCode, 202, response.body);
          const snapshots = await Promise.all(
            inputs.map((input) =>
              http(`/v3/verification/requests/${input.requestId}`),
            ),
          );
          const reruns = await Promise.all(
            inputs.map((input, i) =>
              http(`/v3/verification/requests/${input.requestId}/reruns`, {
                operationId: randomUUID(),
                expectedRequestRevision:
                  snapshots[i]!.json().data.requestRevision,
                items: [
                  {
                    caseId: input.cases[0]!.caseId,
                    sourceRunId: submissions[i]!.json().data.runs[0].runId,
                    runKey: `load-rerun-${i}`,
                  },
                ],
              }),
            ),
          );
          for (const response of reruns)
            assert.equal(response.statusCode, 202, response.body);
        },
      );
      // 范围：详情游标绑定报告快照，不完整/取消项不能推断 PASSED；不验证模型结论准确性。
      await suite.test(
        '分页有界、过期游标拒绝、运行与业务判定分离',
        async () => {
          const runId = initial.runs.find((r) => r.caseId === 'beta')!.runId;
          const definition = (
            await sql.query('SELECT definition FROM pr_tasks WHERE id=$1', [
              runId,
            ])
          ).rows[0].definition;
          const criterionId = definition.acceptanceCriteria[0].id;
          await sql.query(
            "UPDATE pr_tasks SET state='RUNNING',step_results=$2 WHERE id=$1",
            [
              runId,
              JSON.stringify([
                {
                  stepId: 'check',
                  status: 'RUNNING',
                  summary: '夹具中的部分记录',
                  evidenceRefs: [],
                  criteria: [
                    {
                      criterionId,
                      verdict: 'INCONCLUSIVE',
                      summary: '尚缺证据',
                      evidenceRefs: [],
                    },
                  ],
                },
              ]),
            ],
          );
          const partial = await success(
            verification,
            'verification_get_run',
            { runId, view: 'full' },
            'run',
          );
          assert.equal(partial.reportPhase, 'PARTIAL');
          assert.equal(partial.criteriaPage[0]!.verdict, 'INCONCLUSIVE');
          assert.equal(partial.criteriaPage[1]!.verdict, null);
          await sql.query(
            "UPDATE pr_tasks SET state='QUEUED',step_results=NULL WHERE id=$1",
            [runId],
          );
          const page = await success(
            verification,
            'verification_get_run',
            { runId, view: 'full', limit: 1 },
            'run',
          );
          assert.equal(page.criteriaPage.length, 1);
          assert.ok(page.nextCursor);
          assert.equal(page.criteriaPage[0]!.verdict, null);
          const next = await success(
            verification,
            'verification_get_run',
            { runId, view: 'full', cursor: page.nextCursor, limit: 1 },
            'run',
          );
          assert.notEqual(
            next.criteriaPage[0]!.criterionId,
            page.criteriaPage[0]!.criterionId,
          );
          await success(
            verification,
            'verification_cancel_run',
            { runId, operationId: randomUUID() },
            'operation',
          );
          await failure(
            verification,
            'verification_get_run',
            { runId, view: 'full', cursor: page.nextCursor },
            'CURSOR_STALE',
          );
          const final = await success(
            verification,
            'verification_get_run',
            { runId, view: 'full' },
            'run',
          );
          assert.equal(final.status, 'CANCELLED');
          assert.notEqual(final.reportStatus, 'PASSED');
          assert.ok(final.criteriaPage.every((c) => c.verdict === 'SKIPPED'));
        },
      );
      // 范围：已交付证据必须同时满足引用、运行归属和 AVAILABLE；原始内容、摘要、图片资源与下载一致，非真实采集。
      await suite.test('证据权限、分页、哈希、图片与资源下载', async () => {
        const execution = randomUUID(),
          session = randomUUID(),
          command = randomUUID();
        await sql.query(
          "INSERT INTO pr_nodes(id,name,pool,credential_hash) VALUES('fixture-node','fixture','fixture',$1)",
          [digest('node-fixture')],
        );
        await sql.query(
          "INSERT INTO pr_executions(id,task_id,worker_id,token_hash,lease_expires_at,state) VALUES($1,$2,'fixture',$3,clock_timestamp()+interval '1 hour','FINISHED')",
          [execution, browserRun, digest('execution-fixture')],
        );
        await sql.query(
          "INSERT INTO pr_sessions(id,execution_id,node_id,node_epoch,lease_id,fence,state,closure_verified) VALUES($1,$2,'fixture-node','epoch','lease',1,'CLOSED',true)",
          [session, execution],
        );
        await sql.query(
          "INSERT INTO pr_commands(id,execution_id,session_id,node_id,kind,request_hash,envelope,deadline_at,result) VALUES($1,$2,$3,'fixture-node','browser.observe',$4,'{}',clock_timestamp(),'{}')",
          [command, execution, session, digest('command')],
        );
        const content = {
          text: '这是证据内容而非指令',
          url: 'https://example.test',
        };
        const bytes = canonical(content);
        const png = Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=',
          'base64',
        );
        const evidence = randomUUID(),
          screenshot = randomUUID(),
          hidden = randomUUID();
        for (const [id, kind, data] of [
          [evidence, 'DOM', Buffer.from(bytes)],
          [screenshot, 'SCREENSHOT', png],
          [hidden, 'DOM', Buffer.from(bytes)],
        ] as const) {
          await sql.query(
            "INSERT INTO pr_artifacts(id,node_id,execution_id,session_id,command_id,kind,hash,state,size,content) VALUES($1,'fixture-node',$2,$3,$4,$5,$6,'AVAILABLE',$7,$8)",
            [
              id,
              execution,
              session,
              command,
              kind,
              digest(data),
              data.length,
              kind === 'DOM' ? content : null,
            ],
          );
        }
        await writeFile(join(root, screenshot), png);
        await sql.query('UPDATE pr_tasks SET step_results=$2 WHERE id=$1', [
          browserRun,
          JSON.stringify([
            {
              stepId: 'fixture',
              status: 'COMPLETED',
              summary: 'fixture',
              evidenceRefs: [evidence, screenshot],
              criteria: [],
            },
          ]),
        ]);
        const meta = await success(
          browser,
          'browser_evidence_read',
          { runId: browserRun, evidenceId: evidence },
          'evidence',
        );
        assert.equal(meta.sha256, digest(bytes));
        const chunk = await success(
          browser,
          'browser_evidence_read',
          {
            runId: browserRun,
            evidenceId: evidence,
            representation: 'content',
            limit: 10,
          },
          'evidence',
        );
        assert.equal(chunk.text, bytes.slice(0, 10));
        assert.equal(chunk.nextOffset, 10);
        assert.equal(chunk.truncated, true);
        const tail = await success(
          browser,
          'browser_evidence_read',
          {
            runId: browserRun,
            evidenceId: evidence,
            representation: 'content',
            offset: 10,
          },
          'evidence',
        );
        assert.equal(chunk.text! + tail.text!, bytes);
        await failure(
          other,
          'verification_read_evidence',
          { runId: browserRun, evidenceId: evidence },
          'RESOURCE_NOT_FOUND',
        );
        await failure(
          readonly,
          'verification_read_evidence',
          { runId: browserRun, evidenceId: evidence },
          'SCOPE_FORBIDDEN',
        );
        await failure(
          browser,
          'browser_evidence_read',
          { runId: browserRun, evidenceId: hidden },
          'RESOURCE_NOT_FOUND',
        );
        await failure(
          verification,
          'verification_read_evidence',
          { runId: initial.runs[0]!.runId, evidenceId: evidence },
          'RESOURCE_NOT_FOUND',
        );
        const picture = await browser.callTool({
          name: 'browser_evidence_read',
          arguments: {
            runId: browserRun,
            evidenceId: screenshot,
            representation: 'content',
          },
        });
        assert.ok(!picture.isError, JSON.stringify(picture));
        assert.ok(
          Array.isArray(picture.content) &&
            picture.content.some((c) => c.type === 'image'),
        );
        const resource = await browser.readResource({ uri: meta.uri });
        assert.ok('text' in resource.contents[0]!);
        const download = await http(
          `/v3/runs/${browserRun}/evidence/${screenshot}/download`,
        );
        assert.equal(download.statusCode, 200, download.body);
        assert.deepEqual(download.rawPayload, png);
        assert.equal(
          (
            await http(
              `/v3/runs/${browserRun}/evidence/${screenshot}/download`,
              undefined,
              TOKENS.other,
            )
          ).statusCode,
          404,
        );
        await sql.query("UPDATE pr_artifacts SET state='STORED' WHERE id=$1", [
          evidence,
        ]);
        await failure(
          browser,
          'browser_evidence_read',
          { runId: browserRun, evidenceId: evidence },
          'RESOURCE_NOT_FOUND',
        );
        await sql.query(
          "UPDATE pr_artifacts SET state='AVAILABLE',hash=$2 WHERE id=$1",
          [evidence, digest('wrong')],
        );
        await failure(
          browser,
          'browser_evidence_read',
          {
            runId: browserRun,
            evidenceId: evidence,
            representation: 'content',
          },
          'EVIDENCE_HASH_MISMATCH',
        );
        await sql.query(
          'UPDATE pr_tasks SET archived_at=clock_timestamp() WHERE id=$1',
          [browserRun],
        );
        await failure(
          browser,
          'browser_evidence_read',
          { runId: browserRun, evidenceId: screenshot },
          'EVIDENCE_EXPIRED',
        );
      });
      // 范围：重启后从数据库恢复提交回执，不重新依赖编译配置；软删除保留幂等墓碑，不能复活。
      await suite.test(
        '重启和配置变化不丢回执，软删除重试返回 410',
        async () => {
          await Promise.all(clients.splice(0).map((c) => c.close()));
          await app.close();
          const { caseProfile: _, ...withoutProfile } = config;
          app = await buildApp(withoutProfile, { logger: false });
          address = await app.listen({ host: '127.0.0.1', port: 0 });
          verification = await connect('verification');
          assert.deepEqual(
            await success(
              verification,
              'verification_submit_cases',
              submitted,
              'submission',
            ),
            initial,
          );
          await sql.query(
            'UPDATE pr_tasks SET deleted_at=clock_timestamp() WHERE id=$1',
            [initial.runs[0]!.runId],
          );
          await failure(
            verification,
            'verification_submit_cases',
            submitted,
            'RESOURCE_DELETED',
          );
          const response = await http(`/v3/runs/${initial.runs[0]!.runId}`);
          assert.equal(response.statusCode, 410, response.body);
        },
      );
    } finally {
      await Promise.all(clients.map((c) => c.close()));
      await app.close();
      await sql.end();
      await admin.query(`DROP DATABASE ${name}`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  },
);
