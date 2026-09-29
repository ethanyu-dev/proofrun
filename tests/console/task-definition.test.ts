import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseTaskDefinition } from '../../apps/console/src/task-definition.ts';

/** 夹具仅用于验证浏览器端任务校验器，不提交任务或访问业务页面。 */
const TASK = JSON.parse(
  readFileSync(
    new URL('../scenarios/basic-form/task.json', import.meta.url),
    'utf8',
  ),
);
const CASE = JSON.parse(
  readFileSync(
    new URL('../../contracts/examples/public-api/case.json', import.meta.url),
    'utf8',
  ),
);

// 范围：实际前端模块可初始化并校验不含 case 的既有任务；不证明页面渲染或浏览器执行成功。
test('前端任务校验器注册引用后可加载并解析普通任务', () => {
  assert.deepEqual(parseTaskDefinition(JSON.stringify(TASK)), TASK);
});

// 范围：前端解析共享 case 引用并执行必填字段校验；不核验登录身份、地址可达性或业务结论。
test('前端任务校验器校验嵌套 case，不能忽略未注册引用', () => {
  const task = { ...TASK, caseDefinition: CASE };
  assert.deepEqual(parseTaskDefinition(JSON.stringify(task)), task);
  const { url: _, ...missingUrl } = CASE;
  assert.throws(
    () =>
      parseTaskDefinition(
        JSON.stringify({ ...TASK, caseDefinition: missingUrl }),
      ),
    /任务定义格式不正确/,
  );
  assert.throws(
    () =>
      parseTaskDefinition(
        JSON.stringify({
          ...TASK,
          caseDefinition: { ...CASE, objective: '旧字段' },
        }),
      ),
    /任务定义格式不正确/,
  );
});

// 范围：控制台 v2 批量导入使用共享 Schema 并拒绝重复身份；不调用真实提交接口或浏览器。
test('JSON 模式可解析结构化 case 数组', async () => {
  const { parseCaseBatch } =
    await import('../../apps/console/src/task-definition');
  const item = {
    caseId: 'fixture',
    platform: '夹具',
    entry: 'https://example.test',
    steps: [
      {
        type: 'verification',
        url: 'https://example.test',
        exec_order: 1,
        description: '检查页面',
        policy: [],
        expected: ['页面可见'],
      },
    ],
    cleanup: [],
  };
  assert.deepEqual(parseCaseBatch(JSON.stringify([item])), [item]);
  assert.throws(() => parseCaseBatch(JSON.stringify([item, item])), /caseId/);
  assert.throws(
    () =>
      parseCaseBatch(
        JSON.stringify([
          { ...item, steps: [{ ...item.steps[0], expected: [] }] },
        ]),
      ),
    /格式不正确/,
  );
});
