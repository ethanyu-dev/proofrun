import {
  selectContext,
  ContextReads,
} from '../../packages/execution-core/dist/execution/context-view.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAgentDecision } from '../../contracts/dist/index.js';
import {
  networkView,
  selectNetwork,
  trimNetworkView,
} from '../../packages/execution-core/dist/evidence/network-view.js';
import { decisionContext } from '../../packages/execution-core/dist/execution/context.js';
import { Workflow } from '../../packages/execution-core/dist/execution/workflow.js';
import {
  NetworkReads,
  retainNetworkSelection,
} from '../../packages/execution-core/dist/evidence/network-reads.js';
import { ChatModel } from '../../apps/agent/dist/model/chat.js';
import { execute } from '../../packages/execution-driver/dist/execution/runner.js';
import { config, grant, FakeControl, finish, modelServer } from './fixture.mjs';

/** 合成的已脱敏网络观察，含相同地址重复请求、重定向和未响应条目。 */
function page() {
  return {
    observationId: 'observation-1',
    url: 'https://fixture.test/pricing',
    title: '价格',
    text: 'GPU 型号与价格',
    targets: [],
    atomic: false,
    artifactRefs: [
      {
        artifactId: 'network-evidence',
        kind: 'NETWORK',
        sha256: 'a'.repeat(64),
      },
    ],
    network: {
      targetId: 'tab-1',
      navigationId: 'navigation-1',
      scope: 'tab-navigation',
      complete: false,
      truncated: false,
      redacted: true,
      requests: [
        {
          requestId: 'document',
          timestamp: 1,
          url: 'https://fixture.test/zh/pricing',
          method: 'GET',
          status: 308,
          redirect: true,
          headers: { location: '/pricing', 'cache-control': 'no-store' },
        },
        {
          requestId: 'asset',
          timestamp: 2,
          url: 'https://fixture.test/a.css',
          method: 'GET',
          status: 200,
        },
        {
          requestId: 'document',
          timestamp: 3,
          url: 'https://fixture.test/pricing',
          method: 'GET',
          status: 200,
        },
        {
          requestId: 'repeat',
          timestamp: 4,
          url: 'https://fixture.test/pricing',
          method: 'GET',
        },
        ...Array.from({ length: 40 }, (_, i) => ({
          requestId: `image-${i}`,
          timestamp: i + 5,
          url: 'https://fixture.test/_next/image',
          method: 'GET',
          status: 200,
          image: { source: `/image-${i}.png`, width: 640, quality: 75 },
          headers: { 'content-type': 'image/webp' },
        })),
      ],
    },
  };
}

/** 使用正式上下文投影，固定身份与执行过程由本地夹具提供。 */
function contextInput(current) {
  const task = grant().task;
  task.objective = 'GPU 型号价格';
  task.acceptanceCriteria[0].expectedResult = 'GPU 型号价格';
  return {
    task,
    current,
    workflow: new Workflow(task.objective).view(),
    preconditions: [],
    evidence: current.artifactRefs.map((ref) => ({
      id: ref.artifactId,
      kind: ref.kind,
      sha256: ref.sha256,
    })),
    history: [],
    previousObservations: [],
    budgetRemaining: { actions: 5, modelCalls: 10, timeMs: 10000 },
    feedback: null,
    maxContextChars: 12000,
  };
}

// 范围：摘要白名单、分页、状态筛选与覆盖范围；合成记录不证明真实 Chromium 网络采集完整。
test('默认摘要只含四个字段，筛选分页不丢失请求且与采集截断分开', () => {
  const current = page();
  const original = structuredClone(current);
  const first = networkView(current);
  assert.equal(first.requests.length, 20);
  assert.equal(first.total, 44);
  assert.equal(first.nextOffset, 20);
  assert.equal(first.omitted, 24);
  assert.equal(first.capture.truncated, false);
  assert.equal(first.capture.complete, false);
  assert.equal(first.detail, null);
  assert.deepEqual(Object.keys(first.requests[0]), [
    'id',
    'url',
    'method',
    'status',
  ]);
  assert.equal(
    JSON.stringify(
      selectNetwork(current, { observationId: current.observationId }),
    ),
    JSON.stringify(
      selectNetwork(current, {
        offset: 0,
        urlContains: '',
        observationId: current.observationId,
      }),
    ),
  );
  const all = [...first.requests];
  let offset = first.nextOffset;
  while (offset !== null) {
    const next = networkView(
      current,
      selectNetwork(current, { observationId: current.observationId, offset }),
    );
    all.push(...next.requests);
    offset = next.nextOffset;
  }
  assert.equal(new Set(all.map((r) => r.id)).size, 44);
  const pending = networkView(current, {
    observationId: current.observationId,
    status: null,
  });
  assert.equal(pending.matched, 1);
  assert.equal(pending.requests[0].status, null);
  const redirect = networkView(current, {
    observationId: current.observationId,
    urlContains: '/zh/',
    status: 308,
  });
  assert.equal(redirect.matched, 1);
  trimNetworkView(first);
  assert.equal(first.nextOffset, 10);
  assert.equal(first.omitted, 34);
  assert.equal(first.capture.truncated, false);
  assert.deepEqual(current, original);
});

// 范围：请求身份、重定向关联、参数详情与引用；不会模拟请求/响应正文或重发业务请求。
test('详情保留已采集元数据，重定向各跳及重复 URL 的身份独立', () => {
  const current = page();
  const list = networkView(current);
  const read = (requestId) =>
    networkView(
      current,
      selectNetwork(current, {
        observationId: current.observationId,
        requestId,
      }),
    ).detail;
  const initial = read(list.requests[0].id);
  assert.deepEqual(initial.captured.headers, {
    location: '/pricing',
    'cache-control': 'no-store',
  });
  assert.equal(initial.redirectToRequestId, list.requests[2].id);
  assert.equal(
    read(list.requests[2].id).redirectFromRequestId,
    list.requests[0].id,
  );
  assert.notEqual(list.requests[2].id, list.requests[3].id);
  assert.deepEqual(initial.evidenceRefs, ['network-evidence']);
  const image = read(list.requests[4].id);
  assert.deepEqual(image.captured.image, {
    source: '/image-0.png',
    width: 640,
    quality: 75,
  });
  image.captured.image.width = 1;
  assert.equal(current.network.requests[4].image.width, 640);
  current.observationId = 'observation-2';
  current.network.requests[3].status = 200;
  assert.deepEqual(
    networkView(current).requests.map((r) => r.id),
    list.requests.map((r) => r.id),
  );
});

// 范围：快照身份和证据归属防止旧详情、跨导航或猜测身份混用；不替代控制面权限测试。
test('旧观察选择自动失效，未知请求和无 NETWORK 证据的读取被拒绝', () => {
  const current = page();
  const requestId = networkView(current).requests[0].id;
  const selection = selectNetwork(current, {
    observationId: current.observationId,
    requestId,
  });
  assert(networkView(current, selection).detail);
  assert.equal(
    networkView(current, { observationId: current.observationId, offset: 20 })
      .detail,
    null,
  );
  current.observationId = 'observation-new';
  assert.equal(networkView(current, selection).detail, null);
  assert.throws(() => selectNetwork(current, selection), {
    code: 'INVALID_MODEL_DECISION',
  });
  assert.throws(
    () =>
      selectNetwork(current, {
        observationId: current.observationId,
        requestId: 'invented',
      }),
    { code: 'INVALID_MODEL_DECISION' },
  );
  assert.throws(
    () =>
      selectNetwork(current, {
        observationId: current.observationId,
        offset: 99,
      }),
    { code: 'INVALID_MODEL_DECISION' },
  );
  current.network.navigationId = 'another-navigation';
  assert.throws(
    () =>
      selectNetwork(current, {
        observationId: current.observationId,
        requestId,
      }),
    { code: 'INVALID_MODEL_DECISION' },
  );
  current.artifactRefs = [];
  assert.throws(
    () => selectNetwork(current, { observationId: current.observationId }),
    { code: 'INVALID_MODEL_DECISION' },
  );
});

// 范围：探测响应按需展开且保留公开请求范围；不调用图片接口，也不验证服务端参数策略。
test('公开探测响应也使用摘要和详情，不冒充页面会话请求', () => {
  const current = page();
  current.network.probe = {
    url: 'https://fixture.test/_next/image',
    quality: 50,
    status: 400,
    credentials: 'omitted',
    scope: 'node-public-probe',
    headers: { 'cache-control': 'no-store' },
  };
  const list = networkView(current, {
    observationId: current.observationId,
    status: 400,
  });
  assert.equal(list.requests.length, 1);
  const detail = networkView(current, {
    observationId: current.observationId,
    requestId: list.requests[0].id,
  }).detail;
  assert.equal(detail.captured.quality, 50);
  assert.equal(detail.captured.scope, 'node-public-probe');
  assert.equal(detail.captured.credentials, 'omitted');
});

// 范围：大量运行时数据下多轮缩减仍从原文摘录，并保留主题与引用；不证明真实模型一定理解或完成页面操作。
test('正文反复缩减不嵌套定位标记，大列表不能先耗尽正文预算', () => {
  const current = page();
  const originalText = Array.from(
    { length: 300 },
    (_, i) =>
      `${i === 150 ? 'GPU 型号价格 H100' : `普通段落 ${i}`} ${'页面原始内容。'.repeat(30)}\n`,
  ).join('');
  current.text = originalText;
  current.runtime = {
    cacheStorage: {
      entries: Array.from({ length: 200 }, (_, i) => ({
        url: `https://fixture.test/${i}/${'x'.repeat(300)}`,
      })),
      complete: true,
      truncated: false,
    },
  };
  const original = structuredClone(current);
  const result = decisionContext({
    ...contextInput(current),
    maxContextChars: 9500,
  });
  assert(result.text.length <= 9500);
  assert(result.context.page.text.length > 1000);
  assert.match(result.context.page.text, /GPU 型号价格 H100/);
  const chunks = [
    ...result.context.page.text.matchAll(
      /\[原文字符 (\d+) 起\]\n([\s\S]*?)(?=\n…中间内容可能省略…\n|$)/g,
    ),
  ];
  assert(chunks.length >= 2);
  for (const chunk of chunks) {
    const start = Number(chunk[1]);
    assert.equal(chunk[2], originalText.slice(start, start + chunk[2].length));
    assert(!chunk[2].includes('[原文字符'));
  }
  assert(result.context.page.runtime.cacheStorage.truncated);
  assert.deepEqual(current, original);
});

// 范围：超大详情必须显式预算失败，不能静默截断响应头后供验收；只测试本地预算边界。
test('主动读取详情保持完整，装不下时明确失败', () => {
  const current = page();
  current.network.requests[0].headers.location =
    '/destination/' + 'x'.repeat(20000);
  const networkSelection = {
    observationId: current.observationId,
    requestId: networkView(current).requests[0].id,
  };
  assert.throws(
    () =>
      decisionContext({
        ...contextInput(current),
        networkSelection,
        maxContextChars: 6000,
      }),
    { code: 'CONTEXT_BUDGET_EXCEEDED' },
  );
});

// 范围：封闭工具协议拒绝越界参数，不向节点开放新的浏览器命令；不连接模型供应商。
test('网络工具协议只允许有界只读查询', () => {
  assert(
    validateAgentDecision({
      type: 'network.requests',
      observationId: 'o',
      status: null,
      offset: 0,
    }),
  );
  assert(
    validateAgentDecision({
      type: 'network.request_detail',
      observationId: 'o',
      requestId: 'r',
    }),
  );
  for (const bad of [
    { type: 'network.requests', observationId: 'o', offset: -1 },
    { type: 'network.requests', observationId: 'o', status: 99 },
    { type: 'network.request_detail', requestId: 'r' },
    {
      type: 'network.request_detail',
      observationId: 'o',
      requestId: 'r',
      url: 'https://external.test/',
    },
  ])
    assert.equal(validateAgentDecision(bad), false);
});

/** 仅给观察回执添加网络夹具及可交付引用；节点端没有增加查询或重放实现。 */
function withNetwork(client) {
  const command = client.command.bind(client);
  client.command = async (...args) => {
    const result = await command(...args);
    if (args[2].type === 'browser.observe') {
      result.data.network = structuredClone(page().network);
      const artifact = {
        id: `network-${result.data.observationId}`,
        kind: 'NETWORK',
        sha256: 'a'.repeat(64),
        state: 'AVAILABLE',
      };
      client.artifacts.push(artifact);
      result.data.artifactRefs.push({
        artifactId: artifact.id,
        kind: artifact.kind,
        sha256: artifact.sha256,
      });
    }
    return result;
  };
}

// 范围：真实 ChatModel HTTP 工具调用贯穿执行器，查询不触发浏览器命令、不消耗动作预算；节点与决策均为夹具。
test('执行器按需加载详情与筛选列表，读取结果可引用且刷新后清除', async () => {
  let chosen;
  const server = await modelServer((context, turn, body) => {
    const view = context.page.network;
    if (turn === 1) {
      assert.equal(view.detail, null);
      assert(!JSON.stringify(view).includes('no-store'));
      const schema = body.tools.find(
        (t) => t.function.name === 'network_request_detail',
      ).function.parameters;
      assert.equal(
        schema.properties.observationId.const,
        context.page.observationId,
      );
      chosen = view.requests[0].id;
      return {
        type: 'network.request_detail',
        observationId: view.observationId,
        requestId: chosen,
      };
    }
    if (turn === 2) {
      assert.equal(view.detail.captured.headers['cache-control'], 'no-store');
      assert(
        context.evidence.some((e) => e.id === view.detail.evidenceRefs[0]),
      );
      assert.equal(context.history.commands.length, 2);
      return {
        type: 'network.requests',
        observationId: view.observationId,
        urlContains: '/_next/image',
        offset: 20,
      };
    }
    if (turn === 3) {
      assert.equal(view.detail.captured.headers['cache-control'], 'no-store');
      assert.equal(view.offset, 20);
      assert.equal(view.matched, 40);
      assert.equal(view.requests.length, 20);
      return {
        type: 'network.request_detail',
        observationId: view.observationId,
        requestId: view.requests[0].id,
      };
    }
    if (turn === 4) {
      assert.equal(view.detail.captured.image.source, '/image-20.png');
      assert.equal(context.page.view, 'network');
      assert(!body.tools.some((tool) => tool.function.name === 'browser_act'));
      return {
        type: 'context.read',
        section: 'page',
        observationId: context.page.observationId,
      };
    }
    if (turn === 5) {
      assert.equal(context.page.view, 'page');
      assert.equal(view.detail.captured.image.source, '/image-20.png');
      assert.equal(context.history.commands.length, 2);
      return { type: 'browser.act', action: 'scroll', value: 'down' };
    }
    assert.equal(view.detail, null);
    assert.equal(view.offset, 0);
    return finish(context);
  });
  const client = new FakeControl();
  withNetwork(client);
  try {
    const settings = {
      ...config,
      modelUrl: server.url,
      maxContextChars: 12000,
    };
    const report = await execute(
      settings,
      client,
      new ChatModel(settings),
      grant(),
    );
    assert.deepEqual(server.errors, []);
    assert.equal(report.verdict, 'PASSED');
    assert.equal(report.executionDetails.modelCalls, 6);
    assert.equal(report.executionDetails.actions, 2);
    assert.deepEqual(
      client.calls.map((c) => c.operation.type),
      ['browser.act', 'browser.observe', 'browser.act', 'browser.observe'],
    );
  } finally {
    await server.close();
  }
});

// 范围：反复读取同一快照终止为无进展，不能获得新动作或模型预算；不验证真实供应商的决策行为。
test('重复读取不能重置循环保护或派发新请求', async () => {
  const server = await modelServer((context) => ({
    type: 'network.request_detail',
    observationId: context.page.observationId,
    requestId: context.page.network.requests[0].id,
  }));
  const client = new FakeControl();
  withNetwork(client);
  try {
    const settings = {
      ...config,
      modelUrl: server.url,
      maxContextChars: 12000,
    };
    const report = await execute(
      settings,
      client,
      new ChatModel(settings),
      grant(),
    );
    assert.deepEqual(server.errors, []);
    assert.equal(report.executionDetails.reasonCode, 'NO_PROGRESS');
    assert.equal(report.executionDetails.modelCalls, 3);
    assert.equal(report.executionDetails.actions, 1);
    assert.equal(
      client.calls.filter((c) => c.operation.type === 'browser.act').length,
      1,
    );
  } finally {
    await server.close();
  }
});

// 范围：模型只能看到账本已登记的 NETWORK 引用，无证据时关闭读取工具；不验证真实上传协议。
test('未登记的网络引用不进入模型视图或开放详情工具', async () => {
  const current = page();
  const args = contextInput(current);
  args.evidence = [];
  const server = await modelServer((context, _turn, body) => {
    assert.deepEqual(context.page.network.evidenceRefs, []);
    assert(
      !body.tools.some((tool) => tool.function.name.startsWith('network_')),
    );
    return { type: 'verification.block', summary: '无已交付网络证据' };
  });
  try {
    await new ChatModel({ ...config, modelUrl: server.url }).decide(
      decisionContext(args),
      new AbortController().signal,
    );
    assert.deepEqual(server.errors, []);
  } finally {
    await server.close();
  }
});

// 范围：非法 ID 经真实执行循环给出纠错反馈，随后可读取合法详情；不在节点侧查询任意附件。
test('无效请求身份只产生反馈，纠正后可以读取真实记录', async () => {
  const server = await modelServer((context, turn) => {
    if (turn === 1)
      return {
        type: 'network.request_detail',
        observationId: context.page.observationId,
        requestId: 'invented',
      };
    if (turn === 2) {
      assert.match(
        JSON.stringify(context.feedback),
        /请求 ID 不属于当前网络快照/,
      );
      return {
        type: 'network.request_detail',
        observationId: context.page.observationId,
        requestId: context.page.network.requests[0].id,
      };
    }
    assert.equal(context.page.network.detail.captured.status, 308);
    return finish(context);
  });
  const client = new FakeControl();
  withNetwork(client);
  try {
    const settings = {
      ...config,
      modelUrl: server.url,
      maxContextChars: 12000,
    };
    const report = await execute(
      settings,
      client,
      new ChatModel(settings),
      grant(),
    );
    assert.deepEqual(server.errors, []);
    assert.equal(report.verdict, 'PASSED');
    assert.equal(report.executionDetails.actions, 1);
    assert.equal(client.observedIds.length, 1);
  } finally {
    await server.close();
  }
});

// 范围：最后一轮允许只读已有详情但不得续费，读取后仍受原模型硬预算限制；不验证供应商延迟。
test('只读收尾可查看网络证据，但不会增加原模型预算', async () => {
  const server = await modelServer((context, _turn, body) => {
    assert.equal(context.state.settlement, 'budget');
    assert(
      body.tools.some(
        (tool) => tool.function.name === 'network_request_detail',
      ),
    );
    assert(!body.tools.some((tool) => tool.function.name === 'browser_act'));
    return {
      type: 'network.request_detail',
      observationId: context.page.observationId,
      requestId: context.page.network.requests[0].id,
    };
  });
  const client = new FakeControl();
  withNetwork(client);
  try {
    const settings = {
      ...config,
      modelUrl: server.url,
      maxContextChars: 12000,
      maxTurns: 1,
    };
    const report = await execute(
      settings,
      client,
      new ChatModel(settings),
      grant(),
    );
    assert.deepEqual(server.errors, []);
    assert.equal(report.executionDetails.modelCalls, 1);
    assert.equal(report.executionDetails.actions, 1);
    assert.equal(
      report.executionDetails.reasonCode,
      'MODEL_TURN_BUDGET_EXCEEDED',
    );
  } finally {
    await server.close();
  }
});

/** 生成供应商原始多工具回复，绕过夹具的单工具封装。 */
function batchReply(decisions, finishReason = 'tool_calls') {
  return {
    raw: {
      choices: [
        {
          finish_reason: finishReason,
          message: {
            role: 'assistant',
            tool_calls: decisions.map(({ type, ...args }) => ({
              type: 'function',
              function: {
                name: type.replaceAll('.', '_'),
                arguments: JSON.stringify(args),
              },
            })),
          },
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 10 },
    },
  };
}

// 范围：零匹配列表和已展开详情可同时保留，刷新仍清除选择；不证明真实页面存在优化图片。
test('空列表和最近详情独立保留，避免切换查询抹掉已知结果', () => {
  const p = page(),
    id = networkView(p).requests[0].id;
  const detail = selectNetwork(p, {
    observationId: p.observationId,
    requestId: id,
  });
  const empty = selectNetwork(p, {
    observationId: p.observationId,
    urlContains: '/missing-image',
  });
  for (const selection of [
    retainNetworkSelection(detail, empty),
    retainNetworkSelection(empty, detail),
  ]) {
    const view = networkView(p, selection);
    assert.equal(view.matched, 0);
    assert.equal(view.requests.length, 0);
    assert.equal(view.detail.captured.headers.location, '/pricing');
  }
  p.observationId = 'new-observation';
  assert.equal(
    networkView(p, retainNetworkSelection(detail, empty)).detail,
    null,
  );
});

// 范围：A/B 交替、批次换序及仅换观察 ID 都不重置保护；不使用真实浏览器时序。
test('网络读取账本拦截交替循环及批次换序，保留空结果回执', () => {
  const p = page(),
    ledger = new NetworkReads(),
    id = networkView(p).requests[0].id;
  const a = () => ({
    type: 'network.requests',
    observationId: p.observationId,
    urlContains: '/missing',
  });
  const b = () => ({
    type: 'network.request_detail',
    observationId: p.observationId,
    requestId: id,
  });
  assert(ledger.read(p, [a()]));
  assert(ledger.read(p, [b()]));
  assert(ledger.read(p, [a()]));
  p.observationId = 'same-network-new-observation';
  assert.equal(ledger.read(p, [b()]), undefined);
  assert.equal(ledger.view(p)[0].matched, 0);
  assert.equal(ledger.view(p).length, 2);
  const batch = new NetworkReads();
  assert(batch.read(p, [a(), b()]));
  assert(batch.read(p, [b(), a()]));
  assert.equal(batch.read(p, [a(), b()]), undefined);
});

// 范围：新网络事实与已保存结论允许有限重读，回执有界而去重集合不丢；不判断结论业务真伪。
test('读取账本只因新事实或已保存结论恢复重读机会，回执有界', () => {
  const p = page(),
    ledger = new NetworkReads();
  const read = (status) => ({
    type: 'network.requests',
    observationId: p.observationId,
    status,
  });
  for (let status = 400; status < 410; status++)
    assert(ledger.read(p, [read(status)]));
  assert.equal(ledger.view(p).length, 8);
  assert(ledger.read(p, [read(400)]));
  assert.equal(ledger.read(p, [read(400)]), undefined);
  ledger.progressed();
  assert(ledger.read(p, [read(400)]));
  p.network.requests[0].status = 200;
  assert(ledger.read(p, [read(400)]));
  assert.equal(ledger.view(p).length, 1);
  const before = ledger.view(p);
  assert.throws(
    () =>
      ledger.read(p, [
        read(500),
        {
          type: 'network.request_detail',
          observationId: p.observationId,
          requestId: 'invalid',
        },
      ]),
    { code: 'INVALID_MODEL_DECISION' },
  );
  assert.deepEqual(ledger.view(p), before);
});

// 范围：真实适配器与执行循环接受一个 HTTP 回复的四项纯读取，逐项交付结果；节点与供应商仍是夹具。
test('多网络工具调用整批读取并保留各项结果，只计一次模型调用', async () => {
  const server = await modelServer((context, turn, body) => {
    if (turn === 1) {
      assert.equal(body.parallel_tool_calls, false);
      const observationId = context.page.observationId;
      return batchReply([
        { type: 'network.requests', observationId, status: 404 },
        { type: 'network.requests', observationId, offset: 20 },
        {
          type: 'network.request_detail',
          observationId,
          requestId: context.page.network.requests[0].id,
        },
        { type: 'network.requests', observationId, status: 500 },
      ]);
    }
    const view = context.page.network;
    assert.equal(view.matched, 0);
    assert.equal(view.detail.captured.status, 308);
    assert.equal(view.additionalResults.length, 3);
    assert.equal(view.additionalResults[0].filter.status, 404);
    assert.equal(view.additionalResults[0].matched, 0);
    assert.equal(view.additionalResults[1].offset, 20);
    assert.equal(
      view.additionalResults[2].detail.captured.headers.location,
      '/pricing',
    );
    assert.equal(context.state.networkReads.length, 4);
    assert.equal(context.history.commands.length, 2);
    return finish(context);
  });
  const client = new FakeControl();
  withNetwork(client);
  try {
    const settings = {
      ...config,
      modelUrl: server.url,
      maxContextChars: 12000,
    };
    const report = await execute(
      settings,
      client,
      new ChatModel(settings),
      grant(),
    );
    assert.deepEqual(server.errors, []);
    assert.equal(report.verdict, 'PASSED');
    assert.equal(report.executionDetails.modelCalls, 2);
    assert.equal(report.executionDetails.actions, 1);
    assert.equal(server.requests.length, 2);
    assert.equal(client.observedIds.length, 1);
  } finally {
    await server.close();
  }
});

// 范围：真实执行循环在四轮内结束 A/B 交替，读取不发浏览器命令；不代表真实模型必然采用结束策略。
test('执行器将列表与详情交替判为无进展，不耗尽全部模型预算', async () => {
  let id;
  const server = await modelServer((context, turn) => {
    id ??= context.page.network.requests[0].id;
    if (turn > 1) assert(context.state.networkReads.length > 0);
    return turn % 2
      ? {
          type: 'network.requests',
          observationId: context.page.observationId,
          urlContains: '/missing',
        }
      : {
          type: 'network.request_detail',
          observationId: context.page.observationId,
          requestId: id,
        };
  });
  const client = new FakeControl();
  withNetwork(client);
  try {
    const settings = {
      ...config,
      modelUrl: server.url,
      maxContextChars: 12000,
    };
    const report = await execute(
      settings,
      client,
      new ChatModel(settings),
      grant(),
    );
    assert.deepEqual(server.errors, []);
    assert.equal(report.executionDetails.reasonCode, 'NO_PROGRESS');
    assert.equal(report.executionDetails.modelCalls, 4);
    assert.equal(report.executionDetails.actions, 1);
  } finally {
    await server.close();
  }
});

// 范围：混合副作用、未知工具、非法参数、超量、截断或夹带 progress 的批次原子拒绝；不测试远端模型修复率。
test('多工具格式校验不默默执行第一项或丢弃其余项', async () => {
  const valid = {
    type: 'network.requests',
    observationId: 'observation-1',
    status: 404,
  };
  const replies = [
    batchReply([valid, { type: 'browser.act', action: 'reload' }]),
    batchReply([valid, { type: 'verification.finish', summary: 'done' }]),
    batchReply([valid, { type: 'unknown.tool' }]),
    batchReply([valid, { ...valid, offset: -1 }]),
    batchReply([valid, { ...valid, progress: { criteria: [] } }]),
    batchReply(Array.from({ length: 5 }, () => valid)),
    batchReply([valid, valid], 'length'),
  ];
  const badJson = batchReply([valid, valid]);
  badJson.raw.choices[0].message.tool_calls[1].function.arguments = '{';
  replies.push(badJson);
  for (const reply of replies) {
    const server = await modelServer(() => reply);
    try {
      const model = new ChatModel({ ...config, modelUrl: server.url });
      await assert.rejects(
        model.decide(
          decisionContext(contextInput(page())),
          new AbortController().signal,
        ),
        { code: 'INVALID_MODEL_DECISION' },
      );
      assert.equal(server.requests.length, 1);
      assert.deepEqual(server.errors, []);
    } finally {
      await server.close();
    }
  }
});

// 范围：供应商畸形工具容器、空项与非字符串参数统一返回协议错误；不模拟真实供应商出现频率。
test('畸形工具回复进入格式纠错，不泄漏原生类型异常', async () => {
  const valid = batchReply([
    { type: 'network.requests', observationId: 'observation-1' },
  ]).raw.choices[0].message.tool_calls[0];
  const malformed = [
    null,
    [],
    'tool_calls',
    { 0: valid, length: 1 },
    { 0: valid, 1: valid, length: 2 },
    [null],
    [valid, null],
    [valid, []],
    [valid, { type: 'function', function: null }],
    [valid, { type: 'function', function: 'network_requests' }],
    [valid, { ...valid, function: { ...valid.function, arguments: {} } }],
    [{ ...valid, function: { ...valid.function, arguments: {} } }],
  ];
  for (const calls of malformed) {
    const reply = batchReply([]);
    reply.raw.choices[0].message.tool_calls = calls;
    const server = await modelServer(() => reply);
    try {
      const model = new ChatModel({ ...config, modelUrl: server.url });
      await assert.rejects(
        model.decide(
          decisionContext(contextInput(page())),
          new AbortController().signal,
        ),
        { code: 'INVALID_MODEL_DECISION' },
      );
      assert.equal(server.requests.length, 1);
      assert.deepEqual(server.errors, []);
    } finally {
      await server.close();
    }
  }
});

// 范围：同批后续 ID/观察失效时首项也不应用，纠错后仍可继续；不模拟节点上传与权限签发。
test('批次任一请求身份失效时不留下部分查询回执', async () => {
  const server = await modelServer((context, turn) => {
    const observationId = context.page.observationId;
    if (turn <= 2)
      return batchReply([
        { type: 'network.requests', observationId, status: 404 },
        {
          type: 'network.request_detail',
          observationId: turn === 1 ? 'old-observation' : observationId,
          requestId: 'invalid',
        },
      ]);
    assert.equal(context.state.networkReads, undefined);
    assert.equal(context.page.network.detail, null);
    assert.equal(context.page.network.filter.urlContains, null);
    assert.equal(context.page.network.additionalResults, undefined);
    assert.match(
      JSON.stringify(context.feedback),
      /请求 ID 不属于当前网络快照/,
    );
    return finish(context);
  });
  const client = new FakeControl();
  withNetwork(client);
  try {
    const settings = {
      ...config,
      modelUrl: server.url,
      maxContextChars: 12000,
    };
    const report = await execute(
      settings,
      client,
      new ChatModel(settings),
      grant(),
    );
    assert.deepEqual(server.errors, []);
    assert.equal(report.verdict, 'PASSED');
    assert.equal(report.executionDetails.actions, 1);
  } finally {
    await server.close();
  }
});

// 范围：批量读取仍受最后一轮模型额度限制，不暗中派发新请求或开启浏览器动作；不覆盖实际服务延迟。
test('收尾批量读取不增加模型预算', async () => {
  const server = await modelServer((context) =>
    batchReply(
      [404, 500].map((status) => ({
        type: 'network.requests',
        observationId: context.page.observationId,
        status,
      })),
    ),
  );
  const client = new FakeControl();
  withNetwork(client);
  try {
    const settings = {
      ...config,
      modelUrl: server.url,
      maxContextChars: 12000,
      maxTurns: 1,
    };
    const report = await execute(
      settings,
      client,
      new ChatModel(settings),
      grant(),
    );
    assert.deepEqual(server.errors, []);
    assert.equal(report.executionDetails.modelCalls, 1);
    assert.equal(report.executionDetails.actions, 1);
    assert.equal(
      report.executionDetails.reasonCode,
      'MODEL_TURN_BUDGET_EXCEEDED',
    );
  } finally {
    await server.close();
  }
});

// 范围：批次每项分页裁剪仍可补读，多个主动详情不可静默截断；不模拟真实模型窗口的 token 估算。
test('批量视图按项保留游标和完整详情，超过固定预算明确失败', () => {
  const current = page(),
    first = networkView(current),
    ids = first.requests.slice(0, 2).map((r) => r.id);
  const view = networkView(
    current,
    { observationId: current.observationId, requestId: ids[0] },
    [{ observationId: current.observationId, requestId: ids[1] }],
  );
  while (trimNetworkView(view)) {}
  assert.equal(view.requests.length, 1);
  assert.equal(view.nextOffset, 1);
  assert.equal(view.additionalResults[0].requests.length, 1);
  assert.equal(view.additionalResults[0].nextOffset, 1);
  assert.equal(view.detail.captured.headers.location, '/pricing');
  current.network.requests[1].headers = { 'cache-control': 'x'.repeat(20000) };
  assert.throws(
    () =>
      decisionContext({
        ...contextInput(current),
        networkSelection: {
          observationId: current.observationId,
          requestId: ids[0],
        },
        networkBatchSelections: [
          { observationId: current.observationId, requestId: ids[1] },
        ],
      }),
    { code: 'CONTEXT_BUDGET_EXCEEDED' },
  );
});

// 范围：分页、筛选和摘要裁剪保持采集范围；夹具只验证投影，不能证明业务页没有遗漏请求。
test('范围内完整不提升为全局完整，旧节点明确缺少覆盖信息', () => {
  const current = page();
  assert.equal(networkView(current).capture.coverage.complete, false);
  assert.deepEqual(networkView(current).capture.coverage.reasons, [
    'COVERAGE_UNAVAILABLE',
  ]);
  current.network.coverage = {
    scope: 'current-main-document-loader-http',
    complete: true,
    reasons: [],
    startedAt: 1000,
    capturedAt: 2000,
    navigationId: current.network.navigationId,
    excludedScopes: ['workers', 'child-frame-loaders', 'future-events'],
  };
  const view = networkView(current, {
    observationId: current.observationId,
    urlContains: 'missing',
  });
  assert.equal(view.matched, 0);
  assert.equal(view.capture.complete, false);
  assert.deepEqual(view.capture.coverage, current.network.coverage);
  const paged = networkView(current, {
    observationId: current.observationId,
    offset: 20,
  });
  trimNetworkView(paged);
  assert.deepEqual(paged.capture.coverage, current.network.coverage);
  paged.capture.coverage.excludedScopes.push('fixture');
  assert.equal(
    current.network.coverage.excludedScopes.includes('fixture'),
    false,
  );
});

// 范围：采集时间变化不绕过循环保护，窗口/完整性变化则可重读；不模拟浏览器漏事件。
test('覆盖快照时钟不是网络进展，实际覆盖变化仍可补证', () => {
  const current = page(),
    ledger = new NetworkReads();
  current.network.coverage = {
    scope: 'current-main-document-loader-http',
    complete: true,
    startedAt: 10,
    capturedAt: 20,
  };
  const read = {
    type: 'network.requests',
    observationId: current.observationId,
  };
  assert(ledger.read(current, [read]));
  current.network.coverage.capturedAt = 30;
  assert(ledger.read(current, [read]));
  current.network.coverage.capturedAt = 40;
  assert.equal(ledger.read(current, [read]), undefined);
  assert.equal(current.network.coverage.capturedAt, 40);
  current.network.coverage.complete = false;
  assert(ledger.read(current, [read]));
  assert(ledger.read(current, [read]));
  assert.equal(ledger.read(current, [read]), undefined);
  current.network.coverage.startedAt = 35;
  assert(ledger.read(current, [read]));
});

// 范围：同快照网络精简、图片隔离、恢复及原始证据不变；合成页不代表真实浏览器验收。
test('网络视图按实际读取切换，恢复页面不丢网络详情与历史身份', () => {
  const current = page();
  current.text = '页面正文'.repeat(800);
  current.targets = [{ target: 'button-1', role: 'button', name: '继续' }];
  const original = structuredClone(current);
  const args = {
    ...contextInput(current),
    image: 'verified-image',
    previousObservations: [{ ...current }],
    maxContextChars: 64000,
  };
  const full = decisionContext(args);
  assert.equal(full.context.page.view, 'page');
  const networkSelection = {
    observationId: current.observationId,
    requestId: networkView(current).requests[0].id,
  };
  const compact = decisionContext({ ...args, networkSelection });
  assert.equal(compact.context.page.text, '');
  assert.deepEqual(compact.context.page.targets, []);
  assert.equal(compact.image, undefined);
  assert.equal(compact.context.history.excerpts.length, 0);
  assert.equal(compact.context.history.omittedExcerpts, 1);
  assert.equal(compact.context.page.coverage.text.returnedChars, 0);
  assert.equal(compact.context.page.coverage.controls.omitted, 1);
  assert(compact.text.length < full.text.length);
  const restored = decisionContext({
    ...args,
    networkSelection,
    contextSelection: selectContext(current, {
      observationId: current.observationId,
      section: 'page',
    }),
  });
  assert.equal(restored.image, args.image);
  assert.equal(restored.context.page.text, original.text);
  assert.deepEqual(restored.context.page.targets, original.targets);
  assert.deepEqual(restored.context.page.network, compact.context.page.network);
  assert.equal(restored.context.history.excerpts[0].textRef, 'page.text');
  assert.deepEqual(current, original);
  current.observationId = 'new-snapshot';
  const fresh = decisionContext({ ...args, current, networkSelection });
  assert.equal(fresh.context.page.view, 'page');
  assert.equal(fresh.context.page.network.detail, null);
});

// 范围：运行时目录分页、采集缺口、错误样本与证据保留；缓存内容由夹具提供，不操作真实 Cache Storage。
test('运行时清单默认摘要，分页原文无损且不会提升采集完整性', () => {
  const current = page();
  current.runtime = {
    version: 1,
    cacheStorage: {
      names: ['bench'],
      entries: Array.from({ length: 45 }, (_, i) => ({
        url: `https://fixture.test/${i}`,
        responseStatus: 200,
      })),
      truncated: true,
      complete: false,
    },
    console: { entries: [{ level: 'error', message: 'boom' }], complete: true },
  };
  current.artifactRefs.push({
    artifactId: 'runtime-evidence',
    kind: 'RUNTIME',
    sha256: 'a'.repeat(64),
  });
  const original = structuredClone(current);
  const args = contextInput(current);
  const summary = decisionContext(args).context.page;
  assert.deepEqual(summary.runtime.cacheStorage.entries, []);
  assert.equal(summary.runtime.console.entries[0].message, 'boom');
  assert.equal(
    summary.runtimeLists.find((item) => item.path === 'cacheStorage.entries')
      .omitted,
    45,
  );
  const entries = [];
  let offset = 0;
  do {
    const selection = selectContext(current, {
      observationId: current.observationId,
      section: 'runtime',
      path: 'cacheStorage.entries',
      offset,
    });
    const result = decisionContext({
      ...args,
      contextSelection: selection,
      image: 'verified-image',
    });
    assert.equal(result.context.page.view, 'runtime');
    assert.equal(result.image, undefined);
    const detail = result.context.page.runtimeDetail;
    assert.deepEqual(detail.capture, { complete: false, truncated: true });
    assert.deepEqual(detail.evidenceRefs, ['runtime-evidence']);
    entries.push(...detail.entries);
    offset = detail.nextOffset;
  } while (offset !== null);
  assert.deepEqual(entries, original.runtime.cacheStorage.entries);
  assert.deepEqual(current, original);
  for (const selection of [
    { observationId: 'old', section: 'page' },
    {
      observationId: current.observationId,
      section: 'runtime',
      path: '__proto__',
    },
    {
      observationId: current.observationId,
      section: 'runtime',
      path: 'cacheStorage.entries',
      offset: 45,
    },
  ])
    assert.throws(() => selectContext(current, selection), {
      code: 'INVALID_MODEL_DECISION',
    });
  assert.equal(
    validateAgentDecision({
      type: 'context.read',
      observationId: current.observationId,
      section: 'runtime',
    }),
    false,
  );
  assert.equal(
    validateAgentDecision({
      type: 'context.read',
      observationId: current.observationId,
      section: 'page',
      offset: 0,
    }),
    false,
  );
});

// 范围：主动详情不能被总预算裁剪成伪完整列表；不评估真实供应商 token 限制。
test('超预算运行时条目明确失败，不能静默裁剪主动分页', () => {
  const current = page();
  current.runtime = { cacheStorage: { entries: [{ url: 'x'.repeat(20000) }] } };
  assert.throws(
    () =>
      decisionContext({
        ...contextInput(current),
        contextSelection: {
          observationId: current.observationId,
          section: 'runtime',
          path: 'cacheStorage.entries',
        },
      }),
    { code: 'CONTEXT_BUDGET_EXCEEDED' },
  );
});

// 范围：缓存读取只消耗原模型轮次，不能借视图恢复增加动作或续费；模型和节点是协议夹具。
test('同快照恢复仍受原模型预算限制', async () => {
  const server = await modelServer((context) => ({
    type: 'context.read',
    observationId: context.page.observationId,
    section: 'page',
  }));
  const client = new FakeControl();
  const command = client.command.bind(client);
  client.command = async (...args) => {
    const result = await command(...args);
    if (args[2].type === 'browser.observe')
      result.data.runtime = { cacheStorage: { entries: [] } };
    return result;
  };
  try {
    const settings = { ...config, modelUrl: server.url, maxTurns: 1 };
    const report = await execute(
      settings,
      client,
      new ChatModel(settings),
      grant(),
    );
    assert.deepEqual(server.errors, []);
    assert.equal(report.executionDetails.modelCalls, 1);
    assert.equal(report.executionDetails.actions, 1);
    assert.equal(client.observedIds.length, 1);
    assert.equal(
      report.executionDetails.reasonCode,
      'MODEL_TURN_BUDGET_EXCEEDED',
    );
  } finally {
    await server.close();
  }
});

// 范围：绕过 ChatModel 的决定仍被执行端阻止隐藏页面动作；浏览器与网络数据为夹具。
test('执行端拒绝网络视图中的动作，恢复视图不重置网络读取', async () => {
  const client = new FakeControl();
  withNetwork(client);
  let turn = 0,
    observedId;
  const model = {
    async decide(input) {
      const context = input.context;
      turn++;
      let decision;
      if (turn === 1) {
        observedId = context.page.observationId;
        decision = { type: 'network.requests', observationId: observedId };
      } else if (turn === 2) {
        assert.equal(context.page.view, 'network');
        decision = { type: 'browser.act', action: 'reload' };
      } else if (turn === 3) {
        assert.equal(context.page.observationId, observedId);
        assert.match(JSON.stringify(context.feedback), /context_read/);
        decision = {
          type: 'context.read',
          observationId: observedId,
          section: 'page',
        };
      } else {
        assert.equal(context.page.view, 'page');
        assert.equal(context.page.observationId, observedId);
        assert.equal(context.state.networkReads.length, 1);
        decision = finish(context);
      }
      return { decision, promptTokens: 0, completionTokens: 0 };
    },
  };
  const report = await execute(config, client, model, grant());
  assert.equal(report.verdict, 'PASSED');
  assert.equal(report.executionDetails.actions, 1);
  assert.equal(client.observedIds.length, 1);
  assert.equal(report.executionDetails.modelCalls, 4);
});

// 范围：已读回执避免跨视图丢失页进度，交替读取不能重置保护；数据是合成缓存，不代表真实页面。
test('运行时回执保留分页进度，采集覆盖元数据不被摘要化', () => {
  const current = page();
  current.runtime = {
    cacheStorage: {
      entries: Array.from({ length: 24 }, (_, i) => ({
        url: String(i),
        responseStatus: 200,
      })),
    },
    console: {
      coverage: { complete: true, excludedScopes: ['a', 'b', 'c', 'd'] },
      entries: [],
    },
  };
  const context = decisionContext(contextInput(current)).context;
  assert.deepEqual(
    context.page.runtime.console.coverage,
    current.runtime.console.coverage,
  );
  assert(
    !context.page.runtimeLists.some((item) => item.path.includes('coverage')),
  );
  const ledger = new ContextReads();
  const runtime = {
    observationId: current.observationId,
    section: 'runtime',
    path: 'cacheStorage.entries',
    offset: 0,
  };
  const restored = { observationId: current.observationId, section: 'page' };
  assert(ledger.read(current, runtime));
  assert(ledger.read(current, restored));
  assert.equal(ledger.view(current)[0].nextOffset, 20);
  assert.deepEqual(ledger.view(current)[0].responseStatuses, [
    { status: '200', count: 20 },
  ]);
  assert(ledger.read(current, runtime));
  assert.equal(ledger.read(current, restored), false);
  assert(ledger.read(current, { ...runtime, offset: 20 }));
  assert.equal(ledger.view(current).at(-1).returned, 4);
  assert.equal(ledger.view(current).at(-1).nextOffset, null);
  current.observationId = 'new';
  assert.deepEqual(ledger.view(current), []);
});

// 范围：已读原文、缓存名称和状态跨视图保留且受预算约束；合成快照不证明真实模型会完成验收。
test('紧凑视图保留已读页面事实和两页缓存名称，不要求重复读取', () => {
  const current = page();
  current.text = '网络核验\n准备完成\n' + '无关正文。'.repeat(3000);
  current.runtime = {
    cacheStorage: {
      names: ['bench-cache'],
      entries: Array.from({ length: 24 }, (_, i) => ({
        cacheName: 'bench-cache',
        url: `https://fixture.test/cache-${i}`,
        responseStatus: 200,
      })),
    },
  };
  const ledger = new ContextReads();
  ledger.read(current, {
    observationId: current.observationId,
    section: 'page',
  });
  const selection = {
    observationId: current.observationId,
    section: 'runtime',
    path: 'cacheStorage.entries',
    offset: 0,
  };
  ledger.read(current, selection);
  ledger.read(current, { ...selection, offset: 20 });
  const result = decisionContext({
    ...contextInput(current),
    contextSelection: { ...selection, offset: 20 },
    contextReads: ledger.view(current),
  });
  assert.equal(result.context.page.text, '');
  assert(JSON.stringify(result.context).length <= 12000);
  const [dom, first, last] = result.context.state.contextReads;
  assert.match(dom.textExcerpt.text, /准备完成/);
  assert.equal(dom.textExcerpt.text, current.text.slice(0, 400));
  assert.equal(dom.textExcerpt.omittedChars, current.text.length - 400);
  for (const receipt of [first, last])
    assert.deepEqual(receipt.cacheNames, {
      values: ['bench-cache'],
      omitted: 0,
    });
  assert.deepEqual(first.responseStatuses, [{ status: '200', count: 20 }]);
  assert.deepEqual(last.responseStatuses, [{ status: '200', count: 4 }]);
  assert.equal(last.nextOffset, null);
  current.observationId = 'updated-observation';
  assert.deepEqual(ledger.view(current), []);
});

// 范围：名称仅从已读条目提取，省略数可见且未知状态不算成功；不覆盖缓存采集器本身。
test('回执限制名称体积并保留未知状态，不把摘要当成全量证明', () => {
  const current = page();
  const names = [
    ...Array.from({ length: 10 }, (_, i) => `cache-${i}`),
    '长'.repeat(129),
  ];
  current.runtime = {
    cacheStorage: {
      names,
      entries: [
        { cacheName: 'known', responseStatus: 200 },
        { cacheName: 'known' },
        {},
      ],
    },
  };
  const ledger = new ContextReads();
  for (const path of ['cacheStorage.names', 'cacheStorage.entries'])
    ledger.read(current, {
      observationId: current.observationId,
      section: 'runtime',
      path,
    });
  const [nameReceipt, entryReceipt] = ledger.view(current);
  assert.deepEqual(nameReceipt.cacheNames, {
    values: names.slice(0, 8),
    omitted: 3,
  });
  assert.deepEqual(entryReceipt.cacheNames, { values: ['known'], omitted: 0 });
  assert.deepEqual(entryReceipt.responseStatuses, [
    { status: '200', count: 1 },
    { status: 'unknown', count: 2 },
  ]);
});

// 范围：同一附件的分页进度与验收结论分离，全部读完才提交；模型和缓存均为夹具，不证明供应商遵循提示。
test('缓存分页用要求进度保存部分发现，同一快照读完后首次登记验收', async () => {
  const client = new FakeControl();
  const command = client.command.bind(client);
  client.command = async (...args) => {
    const result = await command(...args);
    if (args[2].type === 'browser.observe') {
      result.data.runtime = {
        cacheStorage: {
          entries: Array.from({ length: 24 }, (_, i) => ({
            url: `https://fixture.test/cache-${i}`,
            responseStatus: 200,
          })),
        },
      };
      const artifact = {
        id: 'runtime-pagination-evidence',
        kind: 'RUNTIME',
        sha256: 'a'.repeat(64),
        state: 'AVAILABLE',
      };
      client.artifacts.push(artifact);
      result.data.artifactRefs.push({
        artifactId: artifact.id,
        kind: artifact.kind,
        sha256: artifact.sha256,
      });
    }
    return result;
  };
  const execution = grant();
  execution.task.acceptanceCriteria[0].evidenceKinds = ['RUNTIME'];
  let round = 0;
  const model = {
    async decide({ context }) {
      round++;
      let decision;
      if (round <= 2) {
        assert.deepEqual(context.state.criteria, []);
        decision = {
          type: 'context.read',
          observationId: context.page.observationId,
          section: 'runtime',
          path: 'cacheStorage.entries',
          offset: round === 1 ? 0 : 20,
        };
        if (round === 2) {
          assert.equal(context.page.runtimeDetail.nextOffset, 20);
          decision.progress = {
            requirements: [
              {
                id: context.task.requirements[0].id,
                status: 'incomplete',
                summary: '前 20 条状态为 200，剩余 4 条待读',
                evidenceRefs: ['runtime-pagination-evidence'],
              },
            ],
          };
        }
      } else {
        assert.equal(round, 3, JSON.stringify(context.feedback));
        assert.deepEqual(context.state.criteria, []);
        assert.equal(context.state.requirements[0].status, 'incomplete');
        assert.equal(context.page.runtimeDetail.nextOffset, null);
        assert.deepEqual(
          context.state.contextReads.map((r) => r.returned),
          [20, 4],
        );
        assert.equal(
          client.artifacts.filter((a) => a.kind === 'RUNTIME').length,
          1,
        );
        decision = finish(context);
        decision.progress.requirements = [
          {
            id: context.task.requirements[0].id,
            status: 'complete',
            summary: '已读完全部 24 条，状态均为 200',
            evidenceRefs: ['runtime-pagination-evidence'],
          },
        ];
      }
      return { decision, promptTokens: 0, completionTokens: 0 };
    },
  };
  const report = await execute(
    { ...config, maxContextChars: 12000 },
    client,
    model,
    execution,
  );
  assert.equal(report.verdict, 'PASSED', JSON.stringify(report));
  assert.equal(report.executionDetails.modelCalls, 3);
  assert.equal(client.observedIds.length, 1);
});
