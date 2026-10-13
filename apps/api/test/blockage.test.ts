import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolClient } from 'pg';
import type { StepResult } from '@proofrun/contracts';
import { ArtifactStore } from '../src/modules/reports/artifacts.js';
import type { Database } from '../src/db.js';
import type { ExecutionContext } from '../src/modules/scheduling/state.js';

/** 模拟已交付证据的数据库查询，覆盖归属与快照不可变规则；真实落库另由 Agent 集成测试覆盖。 */
function fixture() {
  let previous: StepResult[] | null = null;
  const store = new ArtifactStore(
    {} as Database,
    '/unused',
    'http://fixture.test',
  );
  const client = {
    query: async (sql: string) => ({
      rows: sql.includes('step_results')
        ? [{ step_results: previous }]
        : [
            { id: 'blocked', kind: 'SCREENSHOT' },
            { id: 'cleanup', kind: 'SCREENSHOT' },
          ],
    }),
  } as unknown as PoolClient;
  const context = {
    id: 'execution',
    task_id: 'task',
    definition: {
      cleanupStepIds: ['cleanup'],
      acceptanceCriteria: [],
      steps: [
        { stepId: 'prepare', type: 'setup' },
        { stepId: 'cleanup', type: 'setup' },
      ],
    },
  } as unknown as ExecutionContext;
  const steps: StepResult[] = [
    {
      stepId: 'prepare',
      status: 'BLOCKED',
      summary: '未确认绑定状态',
      criteria: [],
      evidenceRefs: ['blocked'],
      startedAt: '2026-10-13T02:00:00Z',
      finishedAt: '2026-10-13T02:01:00Z',
      blockage: {
        conditions: [
          {
            id: 'binding',
            description: '未绑定 GitHub',
            summary: '未能确认',
            status: 'UNCONFIRMED',
          },
        ],
        evidenceRefs: ['blocked'],
        recordedAt: '2026-10-13T02:01:00Z',
      },
    },
    {
      stepId: 'cleanup',
      status: 'SKIPPED',
      summary: '环境未就绪',
      criteria: [],
      evidenceRefs: [],
      startedAt: null,
      finishedAt: '2026-10-13T02:01:00Z',
    },
  ];
  return {
    steps,
    validate: (value = steps) => store.validateSteps(client, context, value),
    save: () => {
      previous = structuredClone(steps);
    },
  };
}

// 范围：阻塞证据须是当前执行已交付且属于本步骤的证据；不验证截图业务含义。
test('阻塞快照拒绝外部证据或其他步骤证据', async () => {
  const f = fixture();
  await f.validate();
  for (const id of ['foreign', 'cleanup']) {
    const steps = structuredClone(f.steps);
    steps[0]!.blockage!.evidenceRefs = [id];
    await assert.rejects(f.validate(steps), { code: 'INVALID_STEPS' });
  }
});

// 范围：持久化后的阻塞快照不可替换为清理画面；不覆盖整个报告归档策略。
test('已保存阻塞截图不可被后续截图覆盖', async () => {
  const f = fixture();
  f.save();
  f.steps[0]!.evidenceRefs.push('cleanup');
  f.steps[0]!.blockage!.evidenceRefs = ['cleanup'];
  await assert.rejects(f.validate(), { code: 'INVALID_STEPS' });
});

// 范围：新版准备门禁在 API 再次校验，cleanup 无法绕过；历史无快照报告保持兼容。
test('环境准备未通过时拒绝提交已执行 cleanup', async () => {
  const f = fixture();
  f.steps[1] = {
    ...f.steps[1]!,
    status: 'COMPLETED',
    startedAt: '2026-10-13T02:01:00Z',
    evidenceRefs: ['cleanup'],
  };
  await assert.rejects(f.validate(), { code: 'INVALID_STEPS' });
  delete f.steps[0]!.blockage;
  await f.validate();
});
