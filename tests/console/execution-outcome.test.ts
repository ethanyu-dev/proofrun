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
