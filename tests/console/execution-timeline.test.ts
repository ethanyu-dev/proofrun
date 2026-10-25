import assert from 'node:assert/strict';
import test from 'node:test';
import type { TaskDetail, StepResult } from '../../contracts/src/index.ts';
import {
  playbackSteps,
  type TimelineCommand,
} from '../../apps/console/src/execution-timeline.ts';

/** 时间区间与截图身份刻意错开，防止夹具相同导致跨步骤混用被掩盖。 */
function fixture(): TaskDetail {
  return {
    archived_at: null,
    definition: {
      steps: [
        { stepId: 'step-1', description: '第一步' },
        { stepId: 'step-2', description: '第二步' },
      ],
    },
    report: {
      steps: [result('step-1', 1, 3), result('step-2', 3, 5)],
      artifacts: [{ id: 'referenced', kind: 'SCREENSHOT', sha256: 'hash' }],
    },
  } as unknown as TaskDetail;
}
/** 简化执行结果仅覆盖回放归属，不构造真实验收结论。 */
function result(id: string, start: number, end: number): StepResult {
  return {
    stepId: id,
    status: 'COMPLETED',
    summary: '',
    startedAt: `2026-10-20T00:00:0${start}Z`,
    finishedAt: `2026-10-20T00:00:0${end}Z`,
    evidenceRefs: id === 'step-1' ? ['referenced'] : [],
    criteria: [],
  };
}
/** 摘要命令没有输入正文，截图通过命令身份关联。 */
function command(id: string, second: number): TimelineCommand {
  return {
    id,
    kind: 'browser.act',
    tabScope: null,
    action: 'click',
    actor: 'AGENT',
    status: 'SUCCEEDED',
    error: null,
    effect: null,
    created_at: `2026-10-20T00:00:0${second}Z`,
    screenshots: [{ id: `image-${id}`, sha256: 'hash', state: 'AVAILABLE' }],
  };
}

// 范围：半开时间区间、明确引用与未归属操作隔离；不验证真实数据库时间精度或截图画面。
test('步骤回放不混用相邻步骤与区间外操作截图', () => {
  const steps = playbackSteps(fixture(), [
    command('before', 0),
    command('one', 2),
    command('two', 3),
    command('after', 5),
  ]);
  assert.deepEqual(
    steps.map((s) => s.commands.map((c) => c.id)),
    [['one'], ['two'], ['before', 'after']],
  );
  assert.deepEqual(
    steps[0]!.screenshots.map((s) => s.id),
    ['image-one', 'referenced'],
  );
  assert.deepEqual(
    steps[1]!.screenshots.map((s) => s.id),
    ['image-two'],
  );
});

// 范围：重叠时间不猜测归属，无截图不拿其他步骤替代；不证明历史记录完整性。
test('重叠与缺失记录明确留空，归档截图保留不可用状态', () => {
  const task = fixture();
  task.report!.steps![1]!.startedAt = '2026-10-20T00:00:01Z';
  task.archived_at = '2026-10-21T00:00:00Z';
  const steps = playbackSteps(task, [command('overlap', 2)]);
  assert.equal(steps[0]!.commands.length, 0);
  assert.equal(steps[1]!.screenshots.length, 0);
  assert.equal(steps[0]!.screenshots[0]!.state, 'ARCHIVED');
  assert.equal(steps[2]!.commands[0]!.id, 'overlap');
});

// 范围：同时运行的不同浏览器分组准确隔离；不覆盖节点实际并发调度。
test('并行步骤按浏览器分组和时间共同归属', () => {
  const task = fixture();
  task.report!.steps![0]!.groupId = 'group-1';
  task.report!.steps![1]!.groupId = 'group-2';
  task.report!.steps![1]!.startedAt = '2026-10-20T00:00:01Z';
  const first = { ...command('one', 2), tabScope: 'group-1' },
    second = { ...command('two', 2), tabScope: 'group-2' };
  const steps = playbackSteps(task, [first, second]);
  assert.deepEqual(
    steps.map((s) => s.commands.map((c) => c.id)),
    [['one'], ['two']],
  );
});
