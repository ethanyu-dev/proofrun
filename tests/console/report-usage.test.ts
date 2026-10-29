import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import type { RequestMetrics, TokenUsage } from '@proofrun/contracts';
import {
  ReportUsage,
  ReportUsageDetails,
} from '../../apps/console/src/components/report-usage.tsx';

/** 静态渲染覆盖顶部及明细的显示规则，不调用模型或读取真实账单。 */
const require = createRequire(
  new URL('../../apps/console/package.json', import.meta.url),
);
const { createElement } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const EMPTY_USAGE: TokenUsage = {
  calls: 0,
  promptTokens: null,
  completionTokens: null,
  totalTokens: null,
};

/** 用独立的执行总量检验隐藏空分项不会改写总计。 */
function metrics(llm: TokenUsage = EMPTY_USAGE): RequestMetrics {
  return {
    executionElapsedMs: 3000,
    execution: llm,
    llm,
    totalTokens: llm.totalTokens,
  };
}

// 范围：纯 LLM 的未加载、未采集和零用量均隐藏 JEV，保留 LLM 与原总计；不验证供应商账单。
test('纯 LLM 报告顶部与明细不展示空 JEV 行', () => {
  for (const value of [
    undefined,
    metrics(),
    metrics({ calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 }),
  ]) {
    for (const component of [ReportUsage, ReportUsageDetails]) {
      const html = renderToStaticMarkup(
        createElement(component, { metrics: value }),
      );
      assert.doesNotMatch(html, /JEV|历史/);
      assert.match(html, /LLM/);
      assert.match(html, value?.totalTokens === 0 ? />0</ : />—</);
    }
  }
});
