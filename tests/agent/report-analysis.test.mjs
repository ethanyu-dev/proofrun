import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeReport } from '../../apps/agent/dist/report-analysis.js';

/** 模型与控制面均为 HTTP 夹具，不证明真实模型归因质量或线上验收。 */
const CONFIG = {
  apiUrl: 'https://control.test',
  requestMs: 1000,
  modelMs: 1000,
  modelUrl: 'https://model.test/v1',
  modelKey: 'fixture',
  model: 'fixture-model',
  maxTokens: 4096,
  tokenParameter: 'max_tokens',
};
// 范围：跳过成功 case，保留异常 case 的完整跨片上下文和原索引；不验证真实模型的简洁性或归因质量。
test('分析仅遍历指定异常 case 的全部分片并保留前序笔记', async (context) => {
  const seen = [];
  const calls = [];
  context.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url.includes('/model-calls/')) {
      calls.push({ url, ...JSON.parse(init.body) });
      return Response.json({ recorded: true });
    }
    if (url.startsWith(CONFIG.apiUrl)) {
      const query = new URL(url).searchParams;
      const record = Number(query.get('record'));
      const caseIndex = query.get('caseIndex');
      seen.push(`${caseIndex}:${record}`);
      return Response.json(
        record === 0
          ? {
              text: `case-${caseIndex}-` + 'x'.repeat(24000),
              next: { record: 1, offset: 0 },
            }
          : { text: `last-observation-${caseIndex}`, next: null },
      );
    }
    const body = JSON.parse(init.body);
    assert.equal(body.max_tokens, 4096);
    const input = JSON.parse(body.messages[1].content);
    if (input.phase === 'final') {
      assert.equal(input.cases.length, 3);
      assert.match(input.cases[0], /last-observation-1/);
      assert.match(input.cases[1], /last-observation-3/);
      assert.match(input.cases[2], /last-observation-4/);
      return Response.json({
        usage: { prompt_tokens: 10, completion_tokens: 2 },
        choices: [{ message: { content: '简洁结论' } }],
      });
    }
    if (input.endOfCase) assert.match(input.previous, /前序笔记/);
    return Response.json({
      usage: { input_tokens: 10, output_tokens: 2 },
      choices: [
        { message: { content: input.endOfCase ? input.text : '前序笔记' } },
      ],
    });
  });
  assert.equal(
    await analyzeReport(
      CONFIG,
      { requestId: 'r', caseCount: 5, caseIndices: [1, 3, 4], token: 'lease' },
      new AbortController().signal,
    ),
    '简洁结论',
  );
  assert.deepEqual(seen, ['1:0', '1:1', '3:0', '3:1', '4:0', '4:1']);
  assert.equal(calls.filter((c) => c.phase === 'start').length, 7);
  assert.equal(
    calls.filter((c) => c.phase === 'start' && c.stage === 'final').length,
    1,
  );
  const receipts = calls.filter((c) => c.phase === 'finish');
  assert.equal(
    receipts.reduce((n, c) => n + c.promptTokens + c.completionTokens, 0),
    84,
  );
  assert.ok(receipts.every((c) => c.status === 'RECEIVED' && c.elapsedMs >= 0));
});
// 范围：缺少分析范围时不读取记录、不调用模型；全成功固定文案由 API 集成测试覆盖。
test('空范围或旧领取缺少范围时不能生成无依据的结论', async (context) => {
  context.mock.method(globalThis, 'fetch', async () => {
    assert.fail('不应发出 HTTP 请求');
  });
  for (const caseIndices of [[], undefined])
    await assert.rejects(
      analyzeReport(
        CONFIG,
        { requestId: 'r', caseCount: 1, caseIndices, token: 'lease' },
        new AbortController().signal,
      ),
      { code: 'INVALID_ANALYSIS' },
    );
});
// 范围：空回复、截断回复和读取失败必须退出，不以局部资料生成“完整”分析。
test('分析拒绝不完整模型回复及失效领取', async (context) => {
  for (const mode of ['empty', 'truncated', 'lease']) {
    context.mock.method(globalThis, 'fetch', async (url) => {
      if (url.includes('/model-calls/'))
        return Response.json({ recorded: true });
      if (url.startsWith(CONFIG.apiUrl))
        return mode === 'lease'
          ? Response.json({ code: 'ANALYSIS_LEASE_LOST' }, { status: 409 })
          : Response.json({ text: 'fact', next: null });
      return Response.json({
        choices: [
          {
            finish_reason: mode === 'truncated' ? 'length' : 'stop',
            message: { content: mode === 'empty' ? '' : '不完整结论' },
          },
        ],
      });
    });
    await assert.rejects(
      analyzeReport(
        CONFIG,
        { requestId: 'r', caseCount: 1, caseIndices: [0], token: 'lease' },
        new AbortController().signal,
      ),
    );
    context.mock.restoreAll();
  }
});

// 范围：无效总结仍记账、回执重送不重复调用模型；不模拟供应商真实账单。
test('无效总结保留用量且回执重送复用调用身份', async (context) => {
  let modelCalls = 0;
  const receipts = [];
  context.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url.includes('/model-calls/')) {
      const body = JSON.parse(init.body);
      if (body.phase === 'finish') {
        receipts.push({ url, ...body });
        if (receipts.length === 1)
          return Response.json({ code: 'UNAVAILABLE' }, { status: 503 });
      }
      return Response.json({ recorded: true });
    }
    if (url.startsWith(CONFIG.apiUrl))
      return Response.json({ text: 'fact', next: null });
    modelCalls++;
    return Response.json({
      usage: { prompt_tokens: 123, completion_tokens: 45 },
      choices: [{ finish_reason: 'length', message: { content: '截断' } }],
    });
  });
  await assert.rejects(
    analyzeReport(
      CONFIG,
      { requestId: 'r', caseCount: 1, caseIndices: [0], token: 'lease' },
      new AbortController().signal,
    ),
    { code: 'INVALID_ANALYSIS' },
  );
  assert.equal(modelCalls, 1);
  assert.equal(receipts.length, 2);
  assert.deepEqual(receipts[0], receipts[1]);
  assert.equal(receipts[0].promptTokens, 123);
  assert.equal(receipts[0].completionTokens, 45);
});

// 范围：传输失败登记安全错误码与空用量，登记失败阻止派发；不推测失败调用的账单。
test('模型失败与登记失败不伪造零用量', async (context) => {
  const receipts = [];
  let modelCalls = 0;
  let rejectStart = false;
  context.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url.includes('/model-calls/')) {
      const body = JSON.parse(init.body);
      if (body.phase === 'start' && rejectStart)
        return Response.json({ code: 'ANALYSIS_LEASE_LOST' }, { status: 409 });
      if (body.phase === 'finish') receipts.push(body);
      return Response.json({ recorded: true });
    }
    if (url.startsWith(CONFIG.apiUrl))
      return Response.json({ text: 'fact', next: null });
    modelCalls++;
    throw new Error('private-provider-detail');
  });
  await assert.rejects(
    analyzeReport(
      CONFIG,
      { requestId: 'r', caseCount: 1, caseIndices: [0], token: 'lease' },
      new AbortController().signal,
    ),
  );
  assert.equal(receipts[0].status, 'ERROR');
  assert.equal(receipts[0].promptTokens, null);
  assert.equal(receipts[0].completionTokens, null);
  assert.ok(!JSON.stringify(receipts).includes('private-provider-detail'));
  rejectStart = true;
  await assert.rejects(
    analyzeReport(
      CONFIG,
      { requestId: 'r', caseCount: 1, caseIndices: [0], token: 'lease' },
      new AbortController().signal,
    ),
  );
  assert.equal(modelCalls, 1);
});
