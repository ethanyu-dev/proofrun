import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import {
  executionOutcome,
  type TaskDetail,
} from '../../contracts/src/index.ts';
import {
  TaskExecutionStatus,
  ExecutionOutcomeDetails,
} from '../../apps/console/src/components/execution-outcome.tsx';
const require = createRequire(
  new URL('../../apps/console/package.json', import.meta.url),
);
const { createElement } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

// 范围：新分类和旧响应静态渲染均不误报服务异常；不模拟 API 部署或历史报告迁移。
test('模型主动阻塞显示执行受阻并保留原始原因码', () => {
  const current = executionOutcome({
    state: 'COMPLETED',
    reportCode: 'MODEL_BLOCKED',
    disposition: 'BLOCKED',
  });
  for (const outcome of [
    current,
    { ...current, category: 'MODEL_ERROR' as const },
  ]) {
    const task = {
      state: 'COMPLETED',
      executionOutcome: outcome,
      executions: [],
    } as unknown as TaskDetail;
    const status = renderToStaticMarkup(
      createElement(TaskExecutionStatus, { task }),
    );
    const details = renderToStaticMarkup(
      createElement(ExecutionOutcomeDetails, { outcome }),
    );
    assert.match(status, /执行受阻/);
    assert.match(details, /执行受阻/);
    assert.match(details, /MODEL_BLOCKED/);
    assert.doesNotMatch(status + details, /模型服务异常/);
  }
});

// 范围：服务端渲染只验证分类与原因独立展示，不代表真实人工超时或浏览器交互验收。
test('阻塞状态不被原始 ERROR 覆盖，原始原因和终止原因同时可见', () => {
  const outcome = executionOutcome({
    state: 'ERROR',
    code: 'SESSION_ENDED',
    controlMode: 'HUMAN',
    blockingCode: 'ENVIRONMENT_NOT_READY',
    blockingReason: '缺少指定测试账号',
  });
  const task = {
    state: 'ERROR',
    executionOutcome: outcome,
    executions: [],
  } as unknown as TaskDetail;
  assert.match(
    renderToStaticMarkup(createElement(TaskExecutionStatus, { task })),
    /环境阻塞/,
  );
  const details = renderToStaticMarkup(
    createElement(ExecutionOutcomeDetails, { outcome }),
  );
  assert.match(details, /缺少指定测试账号/);
  assert.match(details, /旧节点未记录具体触发原因/);
  assert.doesNotMatch(details, /人工处理超时/);
});

// 范围：历史 MODEL_ERROR 可根据具体原因区分决策校验与服务故障；只验证静态呈现，不模拟供应商故障。
test('非法决策显示校验失败，服务请求错误保留服务异常文案', () => {
  for (const [code, label] of [
    ['INVALID_MODEL_DECISION', '模型决策校验失败'],
    ['MODEL_REQUEST_FAILED', '模型服务异常'],
  ]) {
    const outcome = executionOutcome({
      state: 'ERROR',
      code: 'AGENT_ERROR',
      reportCode: code,
    });
    const task = {
      state: 'ERROR',
      executionOutcome: outcome,
      executions: [],
    } as unknown as TaskDetail;
    for (const markup of [
      renderToStaticMarkup(createElement(TaskExecutionStatus, { task })),
      renderToStaticMarkup(createElement(ExecutionOutcomeDetails, { outcome })),
    ]) {
      assert(markup.includes(label!));
      assert.match(markup, /data-tone="danger"/);
      if (code === 'INVALID_MODEL_DECISION')
        assert.doesNotMatch(markup, /模型服务异常/);
    }
  }
});

// 范围：人工原因原文与专属终态静态展示；不运行 HITL 输入页面或浏览器。
test('人为判定无法执行展示原因且不被后续清理错误覆盖', () => {
  const outcome = executionOutcome({
    state: 'COMPLETED',
    code: 'CLOSURE_UNVERIFIED',
    reportCode: 'HUMAN_UNEXECUTABLE',
    humanReason: '没有团队邀请权限',
  });
  assert.equal(outcome.category, 'HUMAN_UNEXECUTABLE');
  const html = renderToStaticMarkup(
    createElement(ExecutionOutcomeDetails, { outcome }),
  );
  assert.match(html, /人为判定无法执行/);
  assert.match(html, /没有团队邀请权限/);
});
