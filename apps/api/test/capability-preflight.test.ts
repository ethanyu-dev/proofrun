import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Coordinator } from '../src/modules/scheduling/coordinator.js';
import { task } from './fixture.js';
import type { VerificationTask } from '@proofrun/contracts';

// 范围：真实调度准入允许带缺口的任务进入入队事务，数据库为到达后终止的替身；不证明线上部署或真实浏览器能力。
test('单任务、事务入口及 case 批次均允许缺少能力的任务入队', async () => {
  let writes = 0;
  const forbidden = async () => {
    writes++;
    throw new Error('已到达入队事务');
  };
  const coordinator = new Coordinator(
    { transaction: forbidden } as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const unsupported = {
    ...task('fixture'),
    objective: '读取 canonical 属性',
  } as VerificationTask;
  const rejects = (promise: Promise<unknown>) =>
    assert.rejects(promise, /已到达入队事务/);
  await rejects(coordinator.submit(unsupported));
  // 公共事务入口复用已冻结的合法浏览器任务，避免把失败归因于事务参数或数据库不可用。
  const browser = {
    ...unsupported,
    taskKind: 'browser' as const,
    acceptanceCriteria: [],
  };
  await rejects(
    coordinator.submitBrowserInTransaction(
      {
        taskId: browser.taskId,
        objective: browser.objective,
        url: browser.target.url,
      },
      {
        query: async (sql: string) =>
          sql.startsWith('SELECT definition')
            ? { rows: [{ definition: browser }] }
            : forbidden(),
      } as never,
    ),
  );
  const novita = JSON.parse(
    await readFile(
      new URL('../../../tests/benchmarks/v2/novita-site.json', import.meta.url),
      'utf8',
    ),
  );
  await rejects(coordinator.submitCaseBatch([novita.task]));
  await rejects(
    coordinator.submitCaseBatch([novita.task], undefined, {
      query: forbidden,
    } as never),
  );
  assert.equal(writes, 4);
});
