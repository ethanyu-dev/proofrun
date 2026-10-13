import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compileStepBudget,
  compileProfilePlan,
} from '../../contracts/dist/index.js';
import { execute } from '../../apps/agent/dist/execution/runner.js';
import { ChatModel } from '../../apps/agent/dist/model/chat.js';
import {
  config,
  grant,
  FakeControl,
  finish as fixtureFinish,
  modelServer,
} from './fixture.mjs';

/** 空验收项的准备/清理同样提交操作证据，不靠夹具默认通过。 */
function finish(context) {
  return {
    ...fixtureFinish(context),
    evidenceRefs: context.observation.artifactRefs.map((ref) => ref.artifactId),
  };
}

/** 每个组两步且共用一个执行，页面事实仍是模拟数据，不代表真实站点环境通过。 */
function profileGrant() {
  const execution = grant();
  execution.task.steps = ['a', 'b'].flatMap((id) => [
    {
      stepId: `${id}-setup`,
      type: 'setup',
      url: execution.task.target.url,
      exec_order: 1,
      description: `准备 ${id}`,
      policy: [`确认 ${id} 资格`],
      expected: [],
    },
    {
      stepId: `${id}-verify`,
      type: 'verification',
      url: execution.task.target.url,
      exec_order: 2,
      description: `检查 ${id}`,
      policy: [],
      expected: ['显示结果'],
    },
  ]);
  execution.task.profilePlan = compileProfilePlan(execution.task.steps);
  execution.task.steps.push({
    stepId: 'cleanup',
    type: 'setup',
    url: execution.task.target.url,
    exec_order: 3,
    description: '恢复测试数据',
    policy: [],
    expected: [],
  });
  execution.task.cleanupStepIds = ['cleanup'];
  execution.task.acceptanceCriteria = ['a', 'b'].map((id) => ({
    id,
    stepId: `${id}-verify`,
    description: `检查 ${id}`,
    expectedResult: '显示结果',
    evidenceKinds: ['DOM'],
  }));
  execution.task.stepBudget = compileStepBudget(execution.task);
  return execution;
}
/** 验证模型 HTTP 协议及执行器调度，控制面和浏览器均为夹具。 */
async function run(decide, prepare = () => {}, client = new FakeControl()) {
  const execution = profileGrant();
  prepare(execution);
  const seen = [];
  const server = await modelServer(async (context) => {
    seen.push([context.executionStep.stepId, context.setupPhase]);
    return decide(context, client);
  });
  const settings = { ...config, modelUrl: server.url, maxContextChars: 30000 };
  try {
    const report = await execute(
      settings,
      client,
      new ChatModel(settings),
      execution,
    );
    assert.deepEqual(server.errors, []);
    return { report, client, seen };
  } finally {
    await server.close();
  }
}

// 范围：模型请求真实重叠、准备与 policy 分开、命令带 tab 归属、收尾屏障；不覆盖 Chromium 实际隔离。
test('同 profile 分组并发，强制 policy 检查后验证并统一清理', async () => {
  const waiting = [];
  const { report, client, seen } = await run(async (context) => {
    if (context.setupPhase === 'PREPARING') {
      assert.deepEqual(
        context.workflow.steps.map((s) => s.requirement),
        [context.executionStep.description],
      );
      await new Promise((resolve) => {
        waiting.push(resolve);
        if (waiting.length === 2) waiting.forEach((done) => done());
      });
    }
    if (context.setupPhase === 'CHECKING')
      assert.deepEqual(
        context.workflow.steps.map((s) => s.requirement),
        context.executionStep.policy,
      );
    return finish(context);
  });
  assert.equal(report.executionDisposition, 'EXECUTED', report.summary);
  assert.equal(report.verdict, 'PASSED');
  assert.equal(client.reports.length, 1);
  assert.deepEqual(
    report.steps.map((s) => s.status),
    Array(5).fill('COMPLETED'),
  );
  assert.equal(report.steps[0].phase, 'READY');
  assert.equal(report.steps[2].phase, 'READY');
  assert.equal(seen.at(-1)[0], 'cleanup');
  assert.deepEqual(
    new Set(client.calls.map((c) => c.operation.tabScope)),
    new Set(['group-1', 'group-2', 'profile-cleanup']),
  );
  const indices = client.modelCalls
    .filter((c) => c.body.phase === 'start')
    .map((c) => c.body.record.callIndex);
  assert.equal(new Set(indices).size, indices.length);
  assert(
    client.modelCalls
      .filter((c) => c.body.phase === 'start')
      .every((c) => c.body.record.stepId),
  );
});

// 范围：一个组 policy 失败只跳过本组验证，阻塞证据保留且禁止清理；不验证真实业务权限。
test('分组不符合环境不阻止兄弟组，并禁止整个 profile 的 cleanup', async () => {
  const { report, client, seen } = await run((context) =>
    context.executionStep.stepId === 'a-setup' &&
    context.setupPhase === 'CHECKING'
      ? { type: 'verification.block', summary: '无法确认甲组资格' }
      : finish(context),
  );
  assert.deepEqual(
    report.steps.map((s) => s.status),
    ['BLOCKED', 'SKIPPED', 'COMPLETED', 'COMPLETED', 'SKIPPED'],
  );
  assert.equal(report.steps[0].reasonCode, 'ENVIRONMENT_NOT_READY');
  assert(
    report.steps[0].blockage.conditions.some(
      (c) => c.description === '确认 a 资格',
    ),
  );
  assert(!seen.some(([id]) => ['a-verify', 'cleanup'].includes(id)));
  assert(!client.calls.some((c) => c.operation.tabScope === 'profile-cleanup'));
  assert.equal(
    report.criteria.find((c) => c.criterionId === 'b').verdict,
    'PASSED',
  );
});

// 范围：无 policy 仍经历新观察，不从 description 推断环境门禁；不证明空 policy 能覆盖任何账号要求。
test('空 policy 在准备完成后观察一次再放行', async () => {
  const { report, seen, client } = await run(finish, (execution) => {
    for (const step of execution.task.steps) step.policy = [];
  });
  assert.equal(report.verdict, 'PASSED');
  assert(!seen.some(([, phase]) => phase === 'CHECKING'));
  assert(
    client.calls.filter(
      (c) =>
        c.operation.type === 'browser.observe' &&
        c.operation.tabScope === 'group-1',
    ).length >= 3,
  );
});

/** 模拟整 profile 的人工暂停和逐项确认；不登录真实站点。 */
class HumanControl extends FakeControl {
  mode = 'AUTO';
  revision = 0;
  requests = [];
  confirmation;
  confirm = true;
  onReturn = () => {};
  async view(execution) {
    return {
      ...(await super.view(execution)),
      controlMode: this.mode,
      controlRevision: this.revision,
      humanConfirmation: this.confirmation,
    };
  }
  async intervene(_grant, revision, reason, _signal, items) {
    assert.equal(revision, this.revision);
    this.requests.push({ reason, items });
    this.mode = 'REQUESTED';
    this.revision++;
  }
  async acknowledge() {
    if (this.mode !== 'REQUESTED') return;
    this.mode = 'HUMAN';
    setTimeout(() => {
      this.revision++;
      this.mode = 'AUTO';
      if (this.confirm)
        this.confirmation = {
          revision: this.revision,
          items: this.requests.at(-1).items,
        };
      this.onReturn();
    }, 10);
  }
}

// 范围：人工显式确认只映射到本次 policy，管理员恢复不生成确认；不验证处理者填写真实性。
for (const confirm of [true, false])
  test(`人工 policy 确认来源 ${confirm ? '逐项提交' : '仅恢复控制'}`, async () => {
    const client = new HumanControl();
    client.confirm = confirm;
    let requested = false;
    const { report } = await run(
      (context) => {
        if (
          context.executionStep.stepId === 'a-setup' &&
          context.setupPhase === 'CHECKING'
        ) {
          if (!requested) {
            requested = true;
            return { type: 'verification.block', summary: '需要人工确认资格' };
          }
          const confirmed = context.workflow.steps.every(
            (step) => step.status === 'recorded',
          );
          assert.equal(confirmed, confirm);
          if (!confirmed)
            return { type: 'verification.block', summary: '资格仍未确认' };
          const complete = finish(context);
          delete complete.workflow;
          return complete;
        }
        return finish(context);
      },
      (execution) => {
        execution.task.environment.allowIntervention = true;
        execution.task.profilePlan.maxConcurrency = 1;
      },
      client,
    );
    assert.equal(client.requests.length, 1);
    assert.match(client.requests[0].reason, /分组 group-1/);
    assert.equal(report.steps[0].status, confirm ? 'COMPLETED' : 'BLOCKED');
  });

// 范围：共享人工登录使兄弟 tab 的在途决定失效，恢复后先复查其 policy；网页/账号均为夹具。
test('人工交还后丢弃兄弟 tab 旧决定，重新检查 policy', async () => {
  const client = new HumanControl();
  let verifyStarted;
  const started = new Promise((resolve) => {
    verifyStarted = resolve;
  });
  let returned;
  const resumed = new Promise((resolve) => {
    returned = resolve;
  });
  client.onReturn = returned;
  let asked = false;
  let bFirst = true;
  let bChecks = 0;
  const { report } = await run(
    async (context) => {
      if (
        context.executionStep.stepId === 'a-setup' &&
        context.setupPhase === 'CHECKING' &&
        !asked
      ) {
        await started;
        asked = true;
        return { type: 'verification.block', summary: '人工确认甲组资格' };
      }
      if (
        context.executionStep.stepId === 'b-setup' &&
        context.setupPhase === 'CHECKING'
      )
        bChecks++;
      if (context.executionStep.stepId === 'b-verify' && bFirst) {
        bFirst = false;
        verifyStarted();
        await resumed;
        return { type: 'browser.act', action: 'click', target: '@e2' };
      }
      return finish(context);
    },
    (execution) => {
      execution.task.environment.allowIntervention = true;
    },
    client,
  );
  assert.equal(report.verdict, 'PASSED', JSON.stringify(report.steps));
  assert.equal(bChecks, 2);
  assert(!client.calls.some((call) => call.operation.action === 'click'));
});

// 范围：并发组及 cleanup 共用一次身份准备并引用同一真实命令；不测试真实凭据或身份提供方。
test('profile 身份准备只执行一次，使用原始入口', async () => {
  const { report, client } = await run(finish, (execution) => {
    execution.task.sessionPlan = {
      version: 1,
      mode: 'identity',
      preparationMs: 120000,
      requirements: [],
      candidates: [
        {
          id: 'fixture',
          label: 'fixture',
          accountKey: 'fixture',
          origins: ['http://intranet.test'],
          checks: [],
          maxConcurrent: 1,
          loginRef: 'private-ref',
        },
      ],
    };
    execution.task.steps[0].url = 'http://intranet.test/another';
  });
  const preparation = client.calls.filter(
    (call) => call.operation.type === 'browser.identity.prepare',
  );
  assert.equal(preparation.length, 1);
  assert.equal(preparation[0].operation.url, 'http://intranet.test/form');
  assert.equal(preparation[0].operation.tabScope, undefined);
  assert.equal(
    report.executionDetails.commandIds.filter((id) => id === preparation[0].id)
      .length,
    1,
  );
  assert(
    report.executionDetails.commandIds.every((id) =>
      client.calls.some((call) => call.id === id),
    ),
  );
  assert.equal(report.verdict, 'PASSED');
});

// 范围：setup 的 expected 在准备阶段交付，独立检查只接收 policy；不解释真实业务语义。
test('setup 非空 expected 不会变成 policy 检查项目', async () => {
  const { report } = await run(
    (context) => {
      if (context.setupPhase === 'CHECKING')
        assert.deepEqual(context.task.acceptanceCriteria, []);
      return finish(context);
    },
    (execution) => {
      execution.task.steps[0].expected = ['准备操作已执行'];
      execution.task.acceptanceCriteria.push({
        id: 'prepared',
        stepId: 'a-setup',
        description: '准备操作',
        expectedResult: '准备操作已执行',
        evidenceKinds: ['DOM'],
      });
    },
  );
  assert.equal(report.verdict, 'PASSED');
  assert.equal(report.steps[0].phase, 'READY');
  assert.equal(
    report.criteria.find((criterion) => criterion.criterionId === 'prepared')
      .verdict,
    'PASSED',
  );
  assert(
    report.steps[0].criteria.every((criterion) =>
      criterion.evidenceRefs.every((ref) =>
        report.steps[0].evidenceRefs.includes(ref),
      ),
    ),
  );
});
