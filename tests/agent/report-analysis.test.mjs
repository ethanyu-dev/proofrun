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
// 范围：跨片与多 case 的完整遍历、模型上下文和最终汇总，不运行真实模型。
test('分析读取所有连续分片并保留前序笔记', async (context) => {
  const seen = [];
  context.mock.method(globalThis, 'fetch', async (url, init) => {
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
      assert.equal(input.cases.length, 2);
      assert.match(input.cases[0], /last-observation-0/);
      assert.match(input.cases[1], /last-observation-1/);
      return Response.json({ choices: [{ message: { content: '简洁结论' } }] });
    }
    if (input.endOfCase) assert.match(input.previous, /前序笔记/);
    return Response.json({
      choices: [
        { message: { content: input.endOfCase ? input.text : '前序笔记' } },
      ],
    });
  });
  assert.equal(
    await analyzeReport(
      CONFIG,
      { requestId: 'r', caseCount: 2, token: 'lease' },
      new AbortController().signal,
    ),
    '简洁结论',
  );
  assert.deepEqual(seen, ['0:0', '0:1', '1:0', '1:1']);
});
// 范围：空回复、截断回复和读取失败必须退出，不以局部资料生成“完整”分析。
test('分析拒绝不完整模型回复及失效领取', async (context) => {
  for (const mode of ['empty', 'truncated', 'lease']) {
    context.mock.method(globalThis, 'fetch', async (url) => {
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
        { requestId: 'r', caseCount: 1, token: 'lease' },
        new AbortController().signal,
      ),
    );
    context.mock.restoreAll();
  }
});
