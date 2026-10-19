import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import {
  FeishuClient,
  FeishuError,
  feishuConfig,
} from '../src/modules/notifications/feishu.js';
import { requestCard } from '../src/modules/notifications/request-card.js';
import type { RequestView } from '../src/modules/notifications/request-source.js';
import {
  caseCard,
  type CaseEvent,
  type CaseView,
} from '../src/modules/notifications/card.js';

/** 所有身份均为夹具值；测试不使用部署中的应用或目标群。 */
const CONFIG = {
  appId: 'cli_fixture',
  appSecret: 'private-fixture-secret',
  chatId: 'oc_fixture',
};
const SIGNAL = new AbortController().signal;
const EVENT: CaseEvent = {
  key: 'control-1',
  kind: 'HITL',
  at: '2026-10-16T02:00:00Z',
  taskId: 'task',
  executionId: 'exec',
  revision: 1,
  reason: '需要人工登录',
};
const VIEW: CaseView = {
  caseId: 'checkout',
  objective: '验证订单提交',
  state: 'WAITING_HUMAN',
  terminal: false,
  endedRequests: [],
  arms: [
    {
      taskId: 'task',
      label: '验证任务',
      state: 'WAITING_HUMAN',
      verdict: null,
      detail: null,
      hasReport: false,
      human: {
        id: 'grant',
        executionId: 'exec',
        revision: 1,
        reason: '登录后继续',
        items: ['<at id=all></at> 登录', '确认权限'],
        deadline: '2026-10-16T02:30:00Z',
      },
    },
  ],
};

// 范围：三项配置同时启用/关闭、非法身份和错误脱敏；不验证应用发布状态或群权限。
test('企业应用配置必须完整，秘密不会出现在错误中', () => {
  assert.equal(feishuConfig(), undefined);
  assert.equal(feishuConfig(' ', '', ''), undefined);
  assert.deepEqual(
    feishuConfig(' cli_fixture ', CONFIG.appSecret, ' oc_fixture '),
    CONFIG,
  );
  for (const values of [
    [CONFIG.appId, CONFIG.appSecret, ''],
    ['', CONFIG.appSecret, CONFIG.chatId],
    ['cli_/bad', CONFIG.appSecret, CONFIG.chatId],
    [CONFIG.appId, '', CONFIG.chatId],
    [CONFIG.appId, CONFIG.appSecret, 'chat/bad'],
  ]) {
    assert.throws(
      () => feishuConfig(values[0], values[1], values[2]),
      (error) =>
        error instanceof Error &&
        error.message.includes('PROOFRUN_FEISHU_APP_ID') &&
        !error.message.includes(CONFIG.appSecret),
    );
  }
});

// 范围：真实回环 HTTP 请求体、认证头、消息身份及更新路径；不向真实飞书发送消息。
test('应用交换令牌后发送共享卡片，并使用消息 ID 更新', async () => {
  const calls: {
    path: string;
    method: string;
    body: any;
    auth: string | undefined;
  }[] = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    calls.push({
      path: request.url!,
      method: request.method!,
      body: JSON.parse(Buffer.concat(chunks).toString()),
      auth: request.headers.authorization,
    });
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify(
        request.url!.includes('/auth/')
          ? { code: 0, tenant_access_token: 'fixture-token', expire: 7200 }
          : { code: 0, data: { message_id: 'om_fixture' } },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request: typeof fetch = (url, options) => {
    const target = new URL(String(url));
    assert.equal(target.origin, 'https://open.feishu.cn');
    assert.equal(options!.redirect, 'error');
    return fetch(origin + target.pathname + target.search, options);
  };
  try {
    const client = new FeishuClient(CONFIG, request);
    const card = caseCard(
      EVENT,
      VIEW,
      'https://console.example.test',
      'admin-fixture',
    );
    assert.equal(await client.send(card, 'stable-uuid', SIGNAL), 'om_fixture');
    await client.update('om_fixture', card, SIGNAL);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0]!.body, {
      app_id: CONFIG.appId,
      app_secret: CONFIG.appSecret,
    });
    assert.equal(calls[0]!.auth, undefined);
    assert.equal(
      calls[1]!.path,
      '/open-apis/im/v1/messages?receive_id_type=chat_id',
    );
    assert.equal(calls[1]!.auth, 'Bearer fixture-token');
    assert.deepEqual(calls[1]!.body, {
      receive_id: CONFIG.chatId,
      uuid: 'stable-uuid',
      msg_type: 'interactive',
      content: JSON.stringify(card),
    });
    assert.equal(calls[2]!.method, 'PATCH');
    assert.equal(calls[2]!.path, '/open-apis/im/v1/messages/om_fixture');
    assert.deepEqual(calls[2]!.body, { content: JSON.stringify(card) });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// 范围：并发共用令牌、临近到期刷新及提前撤销后仅刷新一次；响应由夹具生成，不证明飞书在线可用。
test('令牌缓存、到期和撤销恢复保持原消息 uuid', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000000 });
  let authCalls = 0;
  let rejected = false;
  let rejectToken = false;
  const bodies: string[] = [];
  const request: typeof fetch = async (url, options) => {
    if (String(url).includes('/auth/')) {
      authCalls++;
      return Response.json({
        code: 0,
        tenant_access_token: `token-${authCalls}`,
        expire: 7200,
      });
    }
    bodies.push(String(options!.body));
    if (rejectToken && !rejected) {
      rejected = true;
      return Response.json({ code: 99991663 });
    }
    return Response.json({ code: 0, data: { message_id: 'om_fixture' } });
  };
  const client = new FeishuClient(CONFIG, request);
  await Promise.all([
    client.send({}, 'one', SIGNAL),
    client.send({}, 'two', SIGNAL),
  ]);
  assert.equal(authCalls, 1);
  t.mock.timers.setTime(1000000 + 7200 * 1000);
  await client.send({}, 'three', SIGNAL);
  assert.equal(authCalls, 2);
  rejectToken = true;
  await client.send({}, 'four', SIGNAL);
  assert.equal(authCalls, 3);
  assert.equal(bodies.at(-1), bodies.at(-2));
});

// 范围：业务错误、HTTP 错误、缺少 ID、无效 JSON 和取消均视为失败，且外部秘密不进入异常；不测试真实限流。
test('飞书错误脱敏，发送必须取得有效消息 ID', async () => {
  for (const failure of [
    'business',
    'http',
    'invalid',
    'missing',
    'abort',
    'redirect',
  ]) {
    const request: typeof fetch = async (url, options) => {
      assert.equal(options!.redirect, 'error');
      if (String(url).includes('/auth/'))
        return Response.json({
          code: 0,
          tenant_access_token: 'private-token',
          expire: 7200,
        });
      if (failure === 'abort') throw new Error('private-token');
      if (failure === 'http')
        return Response.json({ code: 0 }, { status: 503 });
      if (failure === 'redirect')
        return new Response('private-response', {
          status: 302,
          headers: { location: 'https://example.test' },
        });
      if (failure === 'invalid') return new Response('private-response');
      if (failure === 'missing') return Response.json({ code: 0, data: {} });
      return Response.json({ code: 230027, msg: 'private-response' });
    };
    await assert.rejects(
      new FeishuClient(CONFIG, request).send({}, 'fixture', SIGNAL),
      (error) =>
        error instanceof FeishuError && !error.message.includes('private'),
    );
  }
  assert.equal(new FeishuError(230031).uneditable, true);
  assert.equal(new FeishuError(230020).uneditable, false);
});

// 范围：HITL 顶部仅保留内容与时间、当前处理信息和按钮同步、体积上限；不代表飞书客户端视觉验收。
test('HITL 卡片精简顶部并同步最新状态，完成不等于验收通过', () => {
  const first = caseCard(EVENT, VIEW, 'https://console.example.test', 'secret');
  assert.equal(first.config.update_multi, true);
  assert.ok(JSON.stringify(first).includes('立即处理'));
  assert.ok(JSON.stringify(first).includes('介入原因：登录后继续'));
  assert.ok(JSON.stringify(first).includes('待办事项'));
  assert.ok(JSON.stringify(first).includes('处理截止：'));
  assert.deepEqual(
    first.elements
      .slice(0, 2)
      .map((element) => ('text' in element ? element.text.content : null)),
    [VIEW.objective, '发生时间：2026/10/16 10:00:00（北京时间）'],
  );
  assert.ok(JSON.stringify(first).includes('<at id=all></at>'));
  assert.ok(!JSON.stringify(first).includes('lark_md'));
  const done: CaseView = {
    ...VIEW,
    state: 'COMPLETED',
    terminal: true,
    endedRequests: ['exec:1'],
    arms: [
      {
        ...VIEW.arms[0]!,
        state: 'COMPLETED',
        verdict: 'FAILED',
        hasReport: true,
        human: null,
      },
    ],
  };
  const updated = caseCard(
    EVENT,
    done,
    'https://console.example.test',
    'secret',
  );
  assert.equal(updated.header.title.content, '自动化测试 · 执行完成');
  const content = JSON.stringify(updated);
  assert.doesNotMatch(content, /Case：|事件：|事件原因：|本轮人工介入/);
  assert.ok(content.includes(VIEW.objective));
  assert.ok(content.includes('验收失败'));
  assert.ok(content.includes('10:00:00'));
  assert.ok(!content.includes('/#/hitl/'));
  assert.ok(content.includes('/#/reports/task'));
  assert.notEqual(updated.header.template, 'green');
  const long = '😀\\\"\u0000'.repeat(3000);
  const large = caseCard(
    { ...EVENT, reason: long },
    {
      ...VIEW,
      objective: long,
      arms: [0, 1].map((i) => ({
        ...VIEW.arms[0]!,
        label: String(i),
        detail: long,
        human: {
          ...VIEW.arms[0]!.human!,
          reason: long,
          items: Array.from({ length: 10 }, () => long),
        },
      })),
    },
    'https://console.example.test',
    'secret',
  );
  assert.ok(
    Buffer.byteLength(JSON.stringify({ content: JSON.stringify(large) })) <
      30 * 1024,
  );
});

// 范围：请求仅列状态和提交时间、报告仅列最终结论、大请求截断和导航；仅检查卡片协议，不验收客户端渲染。
test('请求与报告按 case 精简展示，保留导航并限制卡片体积', () => {
  const cases: CaseView[] = Array.from({ length: 100 }, (_, i) => ({
    ...VIEW,
    caseId: `case-${i}`,
    objective: '😀\\\"'.repeat(1000),
    state: 'COMPLETED',
    terminal: true,
    arms: [
      {
        ...VIEW.arms[0]!,
        taskId: `task-${i}`,
        label: '实验组 B',
        state: 'COMPLETED',
        verdict: i ? 'PASSED' : 'FAILED',
        hasReport: true,
        human: null,
      },
    ],
  }));
  const view: RequestView = {
    ...VIEW,
    requestId: 'request-id',
    cases,
    state: 'COMPLETED',
    terminal: true,
    arms: cases.flatMap((item) => item.arms),
  };
  const card = requestCard(
    { ...EVENT, kind: 'COMPLETED' },
    view,
    'https://console.example.test',
    'secret',
  );
  const body = JSON.stringify(card);
  assert.equal(card.header.title.content, '自动化测试 · 验收失败');
  assert.ok(body.includes('最终结论：验收通过'));
  assert.ok(body.includes('最终结论：验收失败'));
  assert.doesNotMatch(
    body,
    /Case 进度|报告覆盖|请求：|提交时间|完成时间|验证状态|汇总结论/,
  );
  assert.ok(card.elements.every((element) => element.tag !== 'hr'));
  const main = requestCard(
    { ...EVENT, kind: 'SUBMITTED' },
    {
      ...view,
      objective: '不得展示请求标题',
      state: 'RUNNING',
      terminal: false,
    },
    'https://console.example.test',
    'secret',
  );
  const mainBody = JSON.stringify(main);
  assert.equal(main.header.title.content, '自动化测试 · 执行中');
  assert.ok(mainBody.includes('验证状态：执行完成'));
  assert.ok(mainBody.includes('提交时间：2026/10/16 10:00:00（北京时间）'));
  assert.doesNotMatch(
    mainBody,
    /不得展示请求标题|请求：|Case 进度|报告覆盖|最终结论|验收结论/,
  );
  assert.ok(main.elements.every((element) => element.tag !== 'hr'));
  assert.ok(body.includes('其余 90 个 Case'));
  assert.ok(body.includes('/#/request-reports/request-id'));
  assert.ok(!body.includes('case-10'));
  assert.doesNotMatch(body, /实验组|对照组|执行模式|\/#\/hitl\//);
  assert.notEqual(card.header.template, 'green');
  assert.ok(Buffer.byteLength(JSON.stringify({ content: body })) < 30 * 1024);
});
