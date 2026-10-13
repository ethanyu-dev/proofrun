import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { compileProfilePlan, type StepResult } from '@proofrun/contracts';
import { ArtifactStore } from '../src/modules/reports/artifacts.js';
import type { Database } from '../src/db.js';
import type { ExecutionContext } from '../src/modules/scheduling/state.js';

/** 只模拟已持久化命令归属，真实并发落库由 Agent 集成测试验证。 */
function fixture() {
  const definitions = [
    'a-setup',
    'a-verify',
    'b-setup',
    'b-verify',
    'cleanup-1',
    'cleanup-2',
  ].map((stepId) => ({
    stepId,
    type: stepId.includes('verify') ? 'verification' : 'setup',
    url: 'https://fixture.test',
    description: '夹具',
    policy: [],
    expected: [],
    exec_order: 1,
  }));
  const context = {
    id: 'execution',
    task_id: 'task',
    definition: {
      steps: definitions,
      acceptanceCriteria: [],
      cleanupStepIds: ['cleanup-1', 'cleanup-2'],
      profilePlan: compileProfilePlan(
        definitions.slice(0, 4) as unknown as NonNullable<
          ExecutionContext['definition']['steps']
        >,
      ),
    },
  } as unknown as ExecutionContext;
  const states: StepResult[] = definitions.map((s) => ({
    stepId: s.stepId,
    status: 'PENDING',
    summary: '等待',
    criteria: [],
    evidenceRefs: [],
    startedAt: null,
    finishedAt: null,
  }));
  const store = new ArtifactStore(
    {} as Database,
    '/unused',
    'https://fixture.test',
  );
  const client = {
    query: async (sql: string) => ({
      rows: sql.includes('step_results')
        ? [{ step_results: null }]
        : ['a-setup', 'b-setup', 'profile-cleanup'].map((scope) => ({
            id: scope,
            kind: 'DOM',
            tab_scope:
              scope === 'a-setup'
                ? 'group-1'
                : scope === 'b-setup'
                  ? 'group-2'
                  : scope,
          })),
    }),
  } as unknown as PoolClient;
  const start = (i: number) => {
    Object.assign(states[i]!, {
      status: 'RUNNING',
      startedAt: new Date().toISOString(),
    });
  };
  const complete = (i: number, scope: string) => {
    start(i);
    Object.assign(states[i]!, {
      status: 'COMPLETED',
      finishedAt: new Date().toISOString(),
      evidenceRefs: [scope],
      ...(definitions[i]!.type === 'setup' && i < 4 ? { phase: 'READY' } : {}),
    });
  };
  return {
    states,
    start,
    complete,
    validate: () => store.validateSteps(client, context, states),
  };
}

// 范围：同组严格顺序和跨组并发、准备完成必须 READY；不判断 policy 业务含义。
test('profile 组内门禁和并发数量由 API 再次验证', async () => {
  const f = fixture();
  f.start(0);
  f.start(2);
  await f.validate();
  f.start(1);
  await assert.rejects(f.validate(), { code: 'INVALID_STEPS' });
  f.states[1]!.status = 'PENDING';
  f.states[1]!.startedAt = null;
  f.complete(0, 'a-setup');
  delete f.states[0]!.phase;
  await assert.rejects(f.validate(), { code: 'INVALID_STEPS' });
  f.states[0]!.phase = 'READY';
  f.start(1);
  await f.validate();
});

// 范围：阻塞组不能执行验证/cleanup，其他组仍能运行；不覆盖模型能否正确识别环境。
test('准备受阻只挡本组，cleanup 等待所有环境就绪', async () => {
  const f = fixture();
  f.start(0);
  f.states[0]!.status = 'BLOCKED';
  f.states[0]!.reasonCode = 'ENVIRONMENT_NOT_READY';
  f.states[0]!.phase = 'CHECKING';
  f.start(2);
  await f.validate();
  f.start(1);
  await assert.rejects(f.validate(), { code: 'INVALID_STEPS' });
  f.states[1]!.status = 'SKIPPED';
  f.states[1]!.startedAt = null;
  f.complete(2, 'b-setup');
  f.complete(3, 'b-setup');
  f.start(4);
  await assert.rejects(f.validate(), { code: 'INVALID_STEPS' });
});

// 范围：证据必须来自本组命令，清理不得越过前一清理；不核验截图真实性。
test('拒绝跨 tab 证据和跳过前序 cleanup', async () => {
  const f = fixture();
  f.complete(0, 'b-setup');
  await assert.rejects(f.validate(), { code: 'INVALID_STEPS' });
  f.states[0]!.evidenceRefs = ['a-setup'];
  f.complete(1, 'a-setup');
  f.complete(2, 'b-setup');
  f.complete(3, 'b-setup');
  f.start(5);
  await assert.rejects(f.validate(), { code: 'INVALID_STEPS' });
  f.states[5]!.status = 'PENDING';
  f.states[5]!.startedAt = null;
  f.start(4);
  await f.validate();
});
