import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { ApiClient } from '../../apps/console/src/api.ts';
import {
  contextModules,
  moduleText,
} from '../../apps/console/src/context-modules.ts';

// 范围：展示拆分保留实际 LLM、JEV 和填写子调用字段及长正文；不代替浏览器交互验收或推断 token 数。
test('上下文按模块保留正文、裁剪标记和混合请求字段', () => {
  const text = '页面事实'.repeat(30_000);
  const context = {
    task: { objective: '验证' },
    budgetRemaining: { actions: 94 },
    observation: {
      text,
      targets: [{ target: 'x', name: '搜索' }],
      atomic: false,
    },
    previousObservations: [{ text: '历史', truncated: true }],
    recentOperations: [],
    evidence: [],
    feedback: null,
    truncated: false,
  };
  const parts = contextModules({
    model: 'fixture',
    messages: [
      { role: 'system', content: '系统指令' },
      { role: 'user', content: JSON.stringify(context) },
    ],
    tools: [{ name: 'fixture_tool' }],
  });
  assert.equal(
    parts.find((part) => part.title === '当前页面正文')?.value,
    text,
  );
  assert.deepEqual(
    parts.find((part) => part.title === '历史页面观察')?.value,
    context.previousObservations,
  );
  assert.equal(
    moduleText(parts.find((part) => part.title === '错误与规划反馈')?.value),
    'null',
  );
  assert.ok(parts.some((part) => part.title === '工具定义'));
  const jev = contextModules({
    model: 'fixture-jev',
    state: { ...context, omittedTargets: 42 },
    questions: { next: {} },
  });
  assert.ok(jev.some((part) => part.title === 'JEV 问题与候选'));
  assert.equal(
    jev.find((part) => part.title === 'JEV 省略目标数量')?.value,
    42,
  );
  const fill = contextModules({
    messages: [
      { role: 'user', content: JSON.stringify({ field: '名称', page: text }) },
    ],
  });
  assert.equal(fill.find((part) => part.title === '待填写字段')?.value, '名称');
  assert.equal(fill.find((part) => part.title === '当前页面正文')?.value, text);
});

/** 夹具只拦截本测试的 fetch，不连接真实控制面或浏览器。 */
const TOKEN = 'console-client-test-credential';
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');

// 范围：写请求网络结果不确定时仅发送一次，并提示核查；不模拟服务端执行成功或回滚。
test('写入失败不自动重试且不在 URL 携带凭据', async (context) => {
  const calls: { path: unknown; options: RequestInit | undefined }[] = [];
  context.mock.method(
    globalThis,
    'fetch',
    async (path: unknown, options: RequestInit | undefined) => {
      calls.push({ path, options });
      throw new Error('network');
    },
  );
  await assert.rejects(
    new ApiClient(TOKEN).json('/v1/tasks', new AbortController().signal, {
      taskId: 'stable-id',
    }),
    /请求结果未确认/,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.path, '/v1/tasks');
  assert.equal(calls[0]?.options?.redirect, 'error');
  assert.equal(calls[0]?.options?.credentials, 'omit');
});

// 范围：搜索中的空格经 URL 编码后可请求，跨源路径在发送前被拒绝；不测试网关部署。
test('请求仅允许同源协议路径', async (context) => {
  const seen: unknown[] = [];
  context.mock.method(globalThis, 'fetch', async (path: unknown) => {
    seen.push(path);
    return Response.json({ tasks: [] });
  });
  const api = new ApiClient(TOKEN);
  await api.json('/v1/tasks?q=a+b%25', new AbortController().signal);
  await assert.rejects(
    api.json(
      'https://elsewhere.invalid/v1/tasks',
      new AbortController().signal,
    ),
    /接口路径无效/,
  );
  assert.deepEqual(seen, ['/v1/tasks?q=a+b%25']);
});

// 范围：下载内容与已存档摘要一致才允许预览，篡改和类型不符会被拒绝；不判定证据业务语义。
test('证据校验拒绝篡改内容与类型', async (context) => {
  const data = '{"text":"页面证据"}';
  let response = () =>
    new Response(data, { headers: { 'content-type': 'application/json' } });
  context.mock.method(globalThis, 'fetch', async () => response());
  const api = new ApiClient(TOKEN);
  assert.equal(
    await (
      await api.artifact(
        'evidence',
        'DOM',
        hash(data),
        new AbortController().signal,
      )
    ).text(),
    data,
  );
  await assert.rejects(
    api.artifact(
      'evidence',
      'DOM',
      hash('other'),
      new AbortController().signal,
    ),
    /摘要与报告不一致/,
  );
  response = () =>
    new Response('<html>fallback</html>', {
      headers: { 'content-type': 'text/html' },
    });
  await assert.rejects(
    api.artifact('evidence', 'DOM', hash(data), new AbortController().signal),
    /类型与报告不一致/,
  );
});

// 范围：超大证据在流式读取中停止并取消流；不压测多用户并发内存。
test('证据超出读取上限会停止流', async (context) => {
  let cancelled = false;
  context.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { 'content-type': 'image/png' } },
      ),
  );
  await assert.rejects(
    new ApiClient(TOKEN).artifact(
      'image',
      'SCREENSHOT',
      '0'.repeat(64),
      new AbortController().signal,
    ),
    /超过可预览大小/,
  );
  assert.equal(cancelled, true);
});

// 范围：表单导入导出的配置保真与协议校验；不代表浏览器交互或真实任务验收。
test('任务表单与 JSON 保留高级配置并拒绝无效定义', async () => {
  const { newTaskDefinition, parseTaskDefinition } =
    await import('../../apps/console/src/task-definition.ts');
  const task = newTaskDefinition();
  task.target.url = 'https://example.com';
  task.objective = '检查公开页面';
  task.acceptanceCriteria[0].description = '页面标题';
  task.acceptanceCriteria[0].expectedResult = '显示指定标题';
  task.executionMode = 'llm';
  task.environment.auth = {
    nodeId: 'node-1',
    stateId: 'login-1',
    restore: false,
  };
  task.budget.timeoutMs = 123456;
  task.acceptanceCriteria[0].evidenceKinds = ['DOM', 'TRACE'];
  assert.deepEqual(parseTaskDefinition(JSON.stringify(task)), task);
  assert.throws(() => parseTaskDefinition('{'), /有效 JSON/);
  assert.throws(
    () => parseTaskDefinition(JSON.stringify({ ...task, extra: true })),
    /格式不正确/,
  );
  assert.throws(
    () =>
      parseTaskDefinition(
        JSON.stringify({
          ...task,
          acceptanceCriteria: [
            task.acceptanceCriteria[0],
            task.acceptanceCriteria[0],
          ],
        }),
      ),
    /不能重复/,
  );
  assert.throws(
    () =>
      parseTaskDefinition(
        JSON.stringify({
          ...task,
          comparison: { id: 'pair', arm: 'jev', sourceTaskId: 'source' },
        }),
      ),
    /对照任务/,
  );
});

// 范围：三种模式在共享协议与 JSON 中往返，旧定义保持单组语义；不验证真实模型或节点容量。
test('执行模式支持并行与两种单组策略，允许从同一登录快照启动', async () => {
  const { newTaskDefinition, parseTaskDefinition } =
    await import('../../apps/console/src/task-definition.ts');
  const task = newTaskDefinition();
  assert.equal(task.executionMode, 'parallel');
  task.target.url = 'https://example.com';
  task.objective = '检查页面';
  task.acceptanceCriteria[0].description = '标题';
  task.acceptanceCriteria[0].expectedResult = '显示标题';
  for (const executionMode of ['parallel', 'llm', 'jev']) {
    assert.equal(
      parseTaskDefinition(JSON.stringify({ ...task, executionMode }))
        .executionMode,
      executionMode,
    );
  }
  const { executionMode, ...legacy } = task;
  assert.equal(
    parseTaskDefinition(JSON.stringify(legacy)).executionMode,
    undefined,
  );
  assert.throws(
    () =>
      parseTaskDefinition(
        JSON.stringify({ ...task, executionMode: 'unknown' }),
      ),
    /格式不正确/,
  );
  assert.throws(
    () =>
      parseTaskDefinition(JSON.stringify({ ...task, taskId: 'x'.repeat(101) })),
    /100/,
  );
  const shared = {
    ...task,
    environment: {
      ...task.environment,
      auth: { nodeId: 'node', stateId: 'state', restore: true },
    },
  };
  assert.deepEqual(
    parseTaskDefinition(JSON.stringify(shared)).environment.auth,
    shared.environment.auth,
  );
});
