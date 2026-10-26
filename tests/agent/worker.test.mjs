import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { grant } from './fixture.mjs';

/** 子进程或夹具失效时限时失败，避免 CI 留下无限等待的 worker。 */
const WAIT_MS = 10_000;
/** 超过旧配置 2 和旧代码上限 8，核对不存在隐含固定槽位。 */
const TASK_COUNT = 12;

/** 等待可观察事件；超时也由测试清理回收子进程与本地监听。 */
async function until(condition) {
  const deadline = Date.now() + WAIT_MS;
  while (!condition()) {
    assert.ok(Date.now() < deadline, '等待 worker 事件超时');
    await delay(20);
  }
}

/** 真实 CLI 连接本地 HTTP 夹具；只签发人工等待状态，不调用模型或浏览器。 */
async function start(t, command = 'serve') {
  const state = {
    accepting: false,
    tasks: [],
    claims: [],
    running: new Set(),
    renewals: new Map(),
    reports: new Map(),
    ended: new Set(),
    failComplete: new Set(),
    failClaim: false,
    holdClaims: false,
    heldClaims: 0,
    events: [],
    unexpected: [],
  };
  let claimInFlight = 0;
  let maxClaimsInFlight = 0;
  const server = createServer((request, response) => {
    void (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = chunks.length
        ? JSON.parse(Buffer.concat(chunks).toString())
        : undefined;
      const send = (value, status = 200) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(value));
      };
      if (request.url === '/v1/worker/claim') {
        state.claims.push({ body, at: performance.now() });
        claimInFlight++;
        maxClaimsInFlight = Math.max(maxClaimsInFlight, claimInFlight);
        response.once('close', () => claimInFlight--);
        if (state.holdClaims) {
          state.heldClaims++;
          return;
        }
        // 领取故意延迟，使测试能发现并发 claim 或无间隔重试。
        await delay(30);
        if (state.failClaim) {
          state.failClaim = false;
          send({ code: 'CLAIM_UNAVAILABLE' }, 503);
          return;
        }
        const execution = state.accepting ? state.tasks.shift() : null;
        if (execution) {
          execution.leaseExpiresAt = new Date(Date.now() + 1500).toISOString();
        }
        send({ execution: execution ?? null });
        return;
      }
      const match = request.url.match(/^\/v1\/executions\/([^/]+)(\/.*)?$/);
      if (!match) {
        state.unexpected.push(request.url);
        send({}, 404);
        return;
      }
      const [, id, path = ''] = match;
      const view = {
        taskState: state.ended.has(id) ? 'CANCELLED' : 'RUNNING',
        state: 'RUNNING',
        controlMode: 'HUMAN',
        controlRevision: 1,
        leaseExpiresAt: new Date(Date.now() + 1500).toISOString(),
        artifacts: [],
      };
      if (!path) {
        state.running.add(id);
        send(view);
      } else if (path === '/heartbeat') {
        state.renewals.set(id, (state.renewals.get(id) ?? 0) + 1);
        send(view);
      } else if (path === '/complete') {
        state.reports.set(id, body.report);
        // 延迟收尾回执，核对关停会等待所有执行完成报告交付。
        await delay(100);
        send(
          state.failComplete.has(id) ? { code: 'REPORT_REJECTED' } : {},
          state.failComplete.has(id) ? 400 : 200,
        );
      } else {
        state.unexpected.push(request.url);
        send({}, 404);
      }
    })().catch((error) => {
      state.unexpected.push(error.message);
      response.destroy();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const child = spawn(process.execPath, ['apps/agent/dist/main.js', command], {
    env: {
      ...process.env,
      PROOFRUN_CONTROL_URL: endpoint,
      PROOFRUN_WORKER_TOKEN: 'worker-fixture-token-with-at-least-32-characters',
      PROOFRUN_WORKER_ID: 'w'.repeat(128),
      PROOFRUN_MODEL_BASE_URL: endpoint,
      PROOFRUN_MODEL_API_KEY: 'fixture',
      PROOFRUN_MODEL: 'fixture',
      PROOFRUN_MODEL_VISION: 'false',
      PROOFRUN_AGENT_POLL_MS: '100',
      PROOFRUN_AGENT_HTTP_MS: '1000',
      // 模拟生产遗留变量；升级后即使保留 2 也必须允许节点签发的全部授权运行。
      PROOFRUN_AGENT_CONCURRENCY: '2',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    let pending = '';
    stream.on('data', (chunk) => {
      output += chunk;
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) {
        try {
          state.events.push(JSON.parse(line));
        } catch {
          // 非 JSON 输出保留在 output，便于断言监听器警告与意外异常。
        }
      }
    });
  }
  const closed = new Promise((resolve, reject) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
    child.once('error', reject);
  });
  const watchdog = setTimeout(() => child.kill('SIGKILL'), WAIT_MS);
  t.after(async () => {
    clearTimeout(watchdog);
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
    await closed;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    state,
    child,
    closed,
    output: () => output,
    maxClaimsInFlight: () => maxClaimsInFlight,
  };
}

// 范围：真实 CLI 和租约守卫并行等待人工，模拟准入恢复、领取/报告失败与关停；不验证真实节点压力、模型或真人操作。
test('serve 由控制面授权持续领取，人工等待和单任务失败不占用固定槽位', async (t) => {
  const fixture = await start(t);
  const { state, child, closed } = fixture;
  const grants = Array.from({ length: TASK_COUNT }, () => grant());
  state.tasks.push(...grants);
  await until(() => state.claims.length >= 3);
  assert.equal(state.running.size, 0, '未获得授权时不能自行执行');
  state.accepting = true;
  await until(() => state.running.size >= 2);
  state.failClaim = true;
  await until(() => state.renewals.size === TASK_COUNT);
  assert.equal(state.reports.size, 0, '等待人工的执行应保持存活并分别续租');
  assert.equal(fixture.maxClaimsInFlight(), 1);
  assert.ok(
    state.claims
      .slice(1)
      .every((claim, i) => claim.at - state.claims[i].at >= 100),
  );
  const ids = state.claims.map(({ body }) => body.workerId);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => id.length <= 128 && /^[A-Za-z0-9_-]+$/.test(id)));
  assert.ok(state.events.some((event) => event.code === 'CLAIM_UNAVAILABLE'));

  // 模拟一个授权被取消且报告被拒绝，其他人工会话继续运行，领取循环仍能接受新授权。
  state.ended.add(grants[0].id);
  state.failComplete.add(grants[0].id);
  await until(() =>
    state.events.some((event) => event.code === 'REPORT_REJECTED'),
  );
  const next = grant();
  state.tasks.push(next);
  await until(() => state.renewals.has(next.id));
  assert.equal(state.reports.size, 1);

  // 关停发生在领取 HTTP 尚未返回时，仍须取消该请求并等待所有活动报告回执。
  state.holdClaims = true;
  await until(() => state.heldClaims === 1);
  const claimCount = state.claims.length;
  child.kill('SIGTERM');
  assert.deepEqual(await closed, { code: 0, signal: null }, fixture.output());
  assert.equal(state.claims.length, claimCount);
  assert.equal(state.reports.size, TASK_COUNT + 1);
  for (const execution of [...grants.slice(1), next]) {
    assert.equal(
      state.reports.get(execution.id).executionDetails.reasonCode,
      'WORKER_STOPPED',
    );
  }
  assert.equal(
    state.events.filter((event) => event.event === 'execution.reported').length,
    TASK_COUNT,
  );
  assert.deepEqual(state.unexpected, []);
  assert.doesNotMatch(
    fixture.output(),
    /MaxListenersExceededWarning|UnhandledPromiseRejection/,
  );
});

// 范围：真实 once 在人工等待时只领取一次，SIGINT 后交付报告再退出；HTTP 状态为夹具，不代表真实人工处理完成。
test('once 等待本次执行结束，不领取第二个任务', async (t) => {
  const fixture = await start(t, 'once');
  const { state, child, closed } = fixture;
  state.accepting = true;
  state.tasks.push(grant(), grant());
  await until(() => state.renewals.size === 1);
  assert.equal(state.claims.length, 1);
  child.kill('SIGINT');
  assert.deepEqual(await closed, { code: 0, signal: null }, fixture.output());
  assert.equal(state.reports.size, 1);
  assert.equal(state.tasks.length, 1);
  assert.deepEqual(state.unexpected, []);
});

// 范围：真实 once 的领取失败返回非零且不自动重试；503 由本地夹具注入，不模拟生产故障。
test('once 领取失败保留非零退出状态', async (t) => {
  const fixture = await start(t, 'once');
  fixture.state.failClaim = true;
  assert.deepEqual(
    await fixture.closed,
    { code: 1, signal: null },
    fixture.output(),
  );
  assert.equal(fixture.state.claims.length, 1);
  assert.ok(
    fixture.state.events.some((event) => event.code === 'CLAIM_UNAVAILABLE'),
  );
});
