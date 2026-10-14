import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolClient } from 'pg';
import type { StepResult } from '@proofrun/contracts';
import { ArtifactStore } from '../src/modules/reports/artifacts.js';
import type { Database } from '../src/db.js';
import type { ExecutionContext } from '../src/modules/scheduling/state.js';

/** 模拟数据库已交付附件与旧快照，只验证服务端校验，不代替真实数据库和页面验收。 */
function fixture() {
  const previous: StepResult = {
    stepId: 'faq',
    status: 'RUNNING',
    summary: '尚缺后两题',
    criteria: [
      {
        criterionId: 'language',
        verdict: 'INCONCLUSIVE',
        summary: '尚缺后两题',
        evidenceRefs: ['old'],
      },
    ],
    evidenceRefs: ['old'],
    startedAt: '2026-10-14T03:00:00Z',
    finishedAt: null,
  };
  const store = new ArtifactStore(
    {} as Database,
    '/unused',
    'http://fixture.test',
  );
  const client = {
    query: async (sql: string) => ({
      rows: sql.includes('step_results')
        ? [{ step_results: [previous] }]
        : [
            { id: 'old', kind: 'DOM' },
            { id: 'new', kind: 'DOM' },
            { id: 'image', kind: 'SCREENSHOT' },
          ],
    }),
  } as unknown as PoolClient;
  const context = {
    id: 'execution',
    task_id: 'task',
    definition: {
      steps: [{ stepId: 'faq', type: 'verification' }],
      acceptanceCriteria: [
        { id: 'language', stepId: 'faq', evidenceKinds: ['DOM'] },
      ],
    },
  } as unknown as ExecutionContext;
  const next = structuredClone(previous);
  next.criteria[0] = {
    ...next.criteria[0]!,
    verdict: 'PASSED',
    summary: '新证据覆盖全部题目',
    evidenceRefs: ['old', 'new'],
  };
  next.evidenceRefs = ['old', 'new'];
  return {
    previous,
    next,
    validate: () => store.validateSteps(client, context, [next]),
  };
}

// 范围：暂存升级可保存并完成，终态不能改写；使用查询夹具，不验证网络传输与事务提交。
test('API 接受运行中补证升级并保留旧来源', async () => {
  const f = fixture();
  await f.validate();
  f.next.status = 'COMPLETED';
  f.next.finishedAt = '2026-10-14T03:01:00Z';
  await f.validate();
  Object.assign(f.previous, structuredClone(f.next));
  await f.validate();
  f.next.criteria[0]!.summary = '改写完成后说明';
  await assert.rejects(f.validate(), { code: 'INVALID_STEPS' });
});

// 范围：不能删旧项/旧证据、复用原附件升级、引用未知附件、改写确定结果或修改终止步骤；不判定文案语义。
test('API 拒绝不合法的验收结果升级', async () => {
  for (const mutation of [
    (f: ReturnType<typeof fixture>) => {
      f.next.criteria = [];
    },
    (f: ReturnType<typeof fixture>) => {
      f.next.criteria[0]!.evidenceRefs = ['new'];
    },
    (f: ReturnType<typeof fixture>) => {
      f.next.criteria[0]!.evidenceRefs = ['old'];
    },
    (f: ReturnType<typeof fixture>) => {
      f.next.criteria[0]!.evidenceRefs = ['old', 'foreign'];
    },
    (f: ReturnType<typeof fixture>) => {
      f.previous.criteria[0]!.verdict = 'FAILED';
    },
    (f: ReturnType<typeof fixture>) => {
      f.previous.status = 'BLOCKED';
    },
  ]) {
    const f = fixture();
    mutation(f);
    await assert.rejects(f.validate(), { code: 'INVALID_STEPS' });
  }
});
