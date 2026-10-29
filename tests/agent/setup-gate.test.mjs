import assert from 'node:assert/strict';
import test from 'node:test';
import { compileStepBudget } from '../../contracts/dist/index.js';
import { execute } from '../../packages/execution-driver/dist/execution/runner.js';
import { ChatModel } from '../../apps/agent/dist/model/chat.js';
import { Workflow } from '../../packages/execution-core/dist/execution/workflow.js';
import { config, grant, FakeControl, finish, modelServer } from './fixture.mjs';

/** 只模拟控制权交接及新观察；不代表真实账号、登录态或网页角色的验收。 */
class SetupControl extends FakeControl {
  mode = 'AUTO';
  revision = 0;
  requests = [];
  transitions = [];
  async view(execution) {
    return {
      ...(await super.view(execution)),
      controlMode: this.mode,
      controlRevision: this.revision,
    };
  }
  async intervene(_grant, revision, reason, _signal, items, reasonCode) {
    assert.equal(revision, this.revision);
    this.requests.push({ reason, items, reasonCode });
    this.mode = 'REQUESTED';
    this.transitions.push(this.mode);
    this.revision++;
  }
  async acknowledge() {
    this.mode = 'HUMAN';
    this.transitions.push(this.mode);
    setTimeout(() => {
      this.mode = 'AUTO';
      this.transitions.push(this.mode);
      this.revision++;
    }, 10);
  }
}

/** 原始 schema 要求直接进入准备工作流，特意使用无账号关键词的约束验证不依赖正则。 */
function setupGrant(allowIntervention = false) {
  const execution = grant();
  execution.task.environment = {
    ...execution.task.environment,
    reuseAuth: true,
    allowIntervention,
  };
  execution.task.steps = [
    {
      stepId: 'prepare',
      type: 'setup',
      url: execution.task.target.url,
      exec_order: 1,
      description: '准备指定的验证环境',
      policy: ['资格应符合输入中约定的甲类条件'],
      expected: [],
    },
    {
      stepId: 'verify',
      type: 'verification',
      url: 'http://intranet.test/business',
      exec_order: 2,
      description: '验收业务结果',
      policy: [],
      expected: ['显示预期结果'],
    },
    {
      stepId: 'cleanup',
      type: 'setup',
      url: execution.task.target.url,
      exec_order: 3,
      description: '清理指定夹具数据',
      policy: [],
      expected: [],
    },
  ];
  execution.task.cleanupStepIds = ['cleanup'];
  execution.task.acceptanceCriteria = [
    {
      id: 'verified',
      stepId: 'verify',
      description: '验收业务结果',
      expectedResult: '显示预期结果',
      evidenceKinds: ['DOM'],
    },
  ];
  execution.task.stepBudget = compileStepBudget(execution.task);
  return execution;
}

/** HTTP 模型工具协议与执行器共用真实代码，页面和人工动作使用内存夹具。 */
async function run(decide, prepare = () => {}) {
  const execution = setupGrant();
  const client = new SetupControl();
  prepare(execution, client);
  const seen = [];
  const server = await modelServer((context, turn, body) => {
    seen.push(context.task.stepId);
    return decide(context, turn, client, body);
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

/** 夹具为获准执行的当前步骤提供证据，不代表真实业务通过。 */
function complete(context) {
  return {
    ...finish(context),
    evidenceRefs: context.page.artifactRefs.map((a) => a.artifactId),
  };
}

// 范围：显式单步未完成和受阻不能被 finish 覆盖；不验证模型是否如实声明。
for (const outcome of ['incomplete', 'blocked']) {
  test(`单步 ${outcome} 不能提交完成`, () => {
    const workflow = new Workflow('核实当前账号');
    workflow.apply(
      {
        requirements: [
          {
            id: 'step-1',
            status: outcome,
            summary: '尚未核实',
            evidenceRefs: [],
          },
        ],
      },
      new Set(),
    );
    assert.throws(
      () => workflow.assertFinish({ type: 'verification.finish' }),
      { code: 'WORKFLOW_INCOMPLETE' },
    );
  });
}

// 范围：未提供逐项完成、仅确认部分条件均拦截业务和清理；不验证真实站点权限。
for (const partial of [false, true]) {
  test(`setup ${partial ? '部分确认' : '缺少完成声明'} 不能通过门禁`, async () => {
    const { report, client, seen } = await run((context) => {
      const value = complete(context);
      if (context.task.stepId === 'prepare') {
        assert.deepEqual(
          context.task.requirements.map((s) => s.requirementRef),
          ['task.description', 'task.policy[0]'],
        );
        assert.equal(context.task.description, '准备指定的验证环境');
        assert.equal(context.task.policy[0], '资格应符合输入中约定的甲类条件');
        if (partial) value.progress.requirements.pop();
        else delete value.progress;
      }
      return value;
    });
    assert.deepEqual(seen, ['prepare']);
    assert.equal(report.executionDetails.reasonCode, 'ENVIRONMENT_NOT_READY');
    assert.deepEqual(
      report.steps.map((s) => s.status),
      ['BLOCKED', 'SKIPPED', 'SKIPPED'],
    );
    assert.equal(report.steps[1].startedAt, null);
    assert.equal(report.criteria[0].verdict, 'SKIPPED');
    assert.equal(client.requests.length, 0);
    assert.ok(
      !client.calls.some(
        (c) => c.operation.target === 'http://intranet.test/business',
      ),
    );
  });
}

// 范围：一次人工交还后所有准备项重新核实并引用新证据，原会话不重复导航；不验证真人处理效果。
test('setup 无法核实立即人工交接，复核通过后才放行业务', async () => {
  let before;
  const { report, client, seen } = await run(
    (context, turn, control, body) => {
      if (turn === 1) {
        before = context.page.artifactRefs[0].artifactId;
        assert.ok(
          !body.tools.some((t) => t.function.name === 'verification_record'),
        );
        return {
          type: 'verification.block',
          reasonCode: 'OTHER',
          summary: '甲类资格缺少证明，不能确认准备完成',
        };
      }
      if (context.task.stepId === 'prepare') {
        assert.equal(control.requests.length, 1);
        assert.ok(
          context.state.requirements.every((s) => s.status === 'pending'),
        );
        assert.notEqual(context.page.artifactRefs[0].artifactId, before);
      }
      return complete(context);
    },
    (execution) => {
      execution.task.environment.allowIntervention = true;
    },
  );
  assert.deepEqual(seen, ['prepare', 'prepare', 'verify', 'cleanup']);
  assert.deepEqual(client.transitions, ['REQUESTED', 'HUMAN', 'AUTO']);
  assert.equal(client.requests[0].reasonCode, 'ENVIRONMENT_NOT_READY');
  assert.match(client.requests[0].reason, /甲类资格/);
  assert.equal(
    client.calls.filter(
      (c) =>
        c.operation.action === 'navigate' &&
        c.operation.target === 'http://intranet.test/form',
    ).length,
    1,
  );
  assert.equal(report.verdict, 'PASSED');
});

// 范围：人工交还仍不满足时不会再次等待或执行下游；不把 fixture 的角色判断当作真实权限校验。
test('人工交还后仍未就绪只交接一次并跳过后续业务', async () => {
  const { report, client, seen } = await run(
    (context) => {
      if (context.task.stepId !== 'prepare') return complete(context);
      const value = complete(context);
      value.progress.requirements[1].status = 'incomplete';
      value.progress.requirements[1].summary = '账号角色未确认';
      return value;
    },
    (execution) => {
      execution.task.environment.allowIntervention = true;
    },
  );
  assert.deepEqual(seen, ['prepare', 'prepare']);
  assert.equal(client.requests.length, 1);
  assert.equal(report.executionDetails.reasonCode, 'ENVIRONMENT_NOT_READY');
  assert.equal(report.steps[1].status, 'SKIPPED');
});

// 范围：人工切换环境后旧证据不可用于新的准备声明；不覆盖伪造内容但使用真实证据 ID 的模型误判。
test('拒绝用人工交还前的证据证明环境就绪', async () => {
  let oldRefs;
  const { report, client, seen } = await run(
    (context, turn) => {
      if (context.task.stepId !== 'prepare') return complete(context);
      if (turn === 1) {
        oldRefs = context.page.artifactRefs.map((a) => a.artifactId);
        return {
          type: 'verification.intervene',
          reason: '请切换到指定账号',
          items: ['确认指定资格'],
        };
      }
      const value = complete(context);
      for (const assessment of value.progress.requirements)
        assessment.evidenceRefs = oldRefs;
      return value;
    },
    (execution) => {
      execution.task.environment.allowIntervention = true;
    },
  );
  assert.equal(client.requests.length, 1);
  assert.equal(report.executionDetails.reasonCode, 'INVALID_MODEL_DECISION');
  assert.ok(!seen.includes('verify'));
  assert.equal(report.steps[2].status, 'SKIPPED');
});

// 范围：显式账号条件在模型前检查，人工返回依旧不匹配则关闭门禁；字符串规则由输入明确指定，不自动猜测角色。
test('已复用登录态也不能跳过显式账号前置条件', async () => {
  const { report, client, seen } = await run(complete, (execution, control) => {
    execution.task.environment.allowIntervention = true;
    execution.task.steps[0].preconditions = [
      {
        id: 'member',
        description: '测试团队成员详情明确为非所有者',
        method: 'text',
        value: '测试团队成员：非所有者',
      },
    ];
    control.pageText = '当前已登录，个人工作区，可切换测试团队';
  });
  assert.deepEqual(seen, []);
  assert.equal(client.requests.length, 1);
  assert.equal(report.executionDetails.reasonCode, 'ENVIRONMENT_NOT_READY');
  assert.equal(report.steps[0].preconditions[0].status, 'UNSATISFIED');
});

// 范围：setup 通过后的业务断言仍保留 FAILED，不误分类为环境问题；不验证实际网页缺陷。
test('环境就绪后业务失败仍归产品验收结论', async () => {
  const { report } = await run((context) => {
    const value = complete(context);
    if (context.task.stepId === 'verify')
      value.progress.criteria[0].verdict = 'FAILED';
    return value;
  });
  assert.equal(report.executionDisposition, 'EXECUTED');
  assert.equal(report.verdict, 'FAILED');
  assert.notEqual(report.executionDetails.reasonCode, 'ENVIRONMENT_NOT_READY');
});

// 范围：全部 32 条 policy 连同描述都保留，最后一项缺失不能通过；不评估自然语言要求的含义。
test('最大数量的 setup 约束不能截断尾项', () => {
  const requirements = [
    '描述',
    ...Array.from({ length: 32 }, (_, i) => `条件 ${i}`),
  ];
  const workflow = new Workflow('背景', 'prepare', requirements);
  assert.equal(workflow.view().steps.length, 33);
  workflow.apply(
    {
      requirements: workflow
        .view()
        .steps.slice(0, 32)
        .map((s) => ({
          id: s.id,
          status: 'complete',
          summary: '夹具确认',
          evidenceRefs: ['e'],
        })),
    },
    new Set(['e']),
  );
  assert.throws(() => workflow.assertFinish({ type: 'verification.finish' }), {
    code: 'WORKFLOW_INCOMPLETE',
  });
});

// 范围：准备停滞时主动交接一次，仍停滞则关闭门禁；不评价模型探索真实页面的能力。
test('setup 重复观察触发人工而非耗尽业务预算', async () => {
  const { report, client, seen } = await run(
    (context) =>
      context.task.stepId === 'prepare'
        ? { type: 'browser.observe' }
        : complete(context),
    (execution) => {
      execution.task.environment.allowIntervention = true;
    },
  );
  assert.equal(client.requests.length, 1);
  assert.equal(report.steps[0].reasonCode, 'ENVIRONMENT_NOT_READY');
  assert.ok(report.steps[0].budgetUsage.modelCalls < 20);
  assert.ok(!seen.includes('verify'));
});

// 范围：环境未就绪时禁止执行 cleanup，退出登录或清 Cookie 不会发生；不连接真实浏览器。
test('环境未 ready 时连 cleanup 也不执行', async () => {
  const { report, client, seen } = await run((context) => {
    assert.equal(context.task.stepId, 'prepare');
    return { type: 'verification.block', summary: '指定资格不符合' };
  });
  assert.deepEqual(seen, ['prepare']);
  assert.equal(report.steps[2].reasonCode, 'ENVIRONMENT_NOT_READY');
  assert.equal(report.steps[2].status, 'SKIPPED');
  assert.equal(report.steps[2].startedAt, null);
  assert.ok(
    !client.calls.some(
      (c) =>
        c.operation.type === 'browser.cookies.clear' ||
        c.operation.action === 'click',
    ),
  );
});

// 范围：setup 未知点击保留基础设施故障并停止后续动作，绝不进入人工重试；不执行真实写入。
test('准备期间未知操作效果不改写为环境问题或人工重试', async () => {
  const { report, client, seen } = await run(
    () => ({ type: 'browser.act', action: 'click', target: '@e2' }),
    (execution, control) => {
      execution.task.environment.allowIntervention = true;
      control.unknown = true;
    },
  );
  assert.equal(report.executionDetails.reasonCode, 'BROWSER_EFFECT_UNKNOWN');
  assert.equal(client.requests.length, 0);
  assert.ok(!seen.includes('verify'));
  assert.equal(report.steps[2].status, 'SKIPPED');
});

// 范围：无效的部分 finish 不持久化准备结论，人工后必须整批重新取证；不模拟真实账号业务。
test('准备完成声明必须整批通过校验后才保存', async () => {
  const { report, client } = await run(
    (context, turn) => {
      const value = complete(context);
      if (turn === 1) value.progress.criteria.pop();
      if (turn === 2) {
        assert.deepEqual(context.state.criteria, []);
        return {
          type: 'verification.intervene',
          reason: '重新核实账号',
          items: ['核实准备条件'],
        };
      }
      return value;
    },
    (execution) => {
      execution.task.environment.allowIntervention = true;
      execution.task.steps[0].expected = ['条件一', '条件二'];
      execution.task.acceptanceCriteria.unshift(
        ...['条件一', '条件二'].map((expectedResult, i) => ({
          id: `prepared-${i}`,
          stepId: 'prepare',
          description: '准备资格',
          expectedResult,
          evidenceKinds: ['DOM'],
        })),
      );
    },
  );
  assert.equal(report.verdict, 'PASSED');
  assert.equal(client.requests.length, 1);
  assert.ok(
    client.stepSnapshots
      .filter((s) => s[0].status === 'RUNNING')
      .every((s) => s[0].criteria.length === 0),
  );
});

// 范围：登录恢复与随后发现的资格条件各自交接，交还后复核通过才放行；人工和账号均为协议夹具。
test('人工登录成功后仍可针对未解决条件再次交接', async () => {
  const { report, client, seen } = await run(
    (context, turn, control) => {
      if (turn === 1)
        return {
          type: 'verification.intervene',
          reasonCode: 'LOGIN_REQUIRED',
          reason: '请完成指定账号登录',
          items: ['登录'],
        };
      if (turn === 2) {
        assert.equal(control.requests.length, 1);
        const value = complete(context);
        value.progress.requirements[1].status = 'incomplete';
        value.progress.requirements[1].summary = '已登录，但甲类资格尚未核实';
        return {
          type: 'verification.block',
          reasonCode: 'IDENTITY_UNCONFIRMED',
          summary: '已登录，仍需确认甲类资格',
          workflow: value.progress,
        };
      }
      if (turn === 3) {
        assert.equal(control.requests.length, 2);
        assert.equal(control.requests[1].items.length, 1);
        assert.match(control.requests[1].items[0], /甲类资格尚未核实/);
        assert.ok(
          context.state.requirements.every((step) => step.status === 'pending'),
        );
      }
      return complete(context);
    },
    (execution) => {
      execution.task.environment.allowIntervention = true;
    },
  );
  assert.deepEqual(seen, [
    'prepare',
    'prepare',
    'prepare',
    'verify',
    'cleanup',
  ]);
  assert.equal(client.requests.length, 2);
  assert.equal(report.verdict, 'PASSED');
});

// 范围：不同原因文字不产生新条件，同条件交还仍失败时停止全部后续；不评估模型业务判断。
test('同一未解决条件不能通过改写原因反复请求人工', async () => {
  const { report, client } = await run(
    (context, turn) => {
      const value = complete(context);
      value.progress.requirements[1].status = 'incomplete';
      value.progress.requirements[1].summary = `第 ${turn} 次仍未核实甲类资格`;
      return {
        type: 'verification.block',
        summary: `原因变化 ${turn}`,
        workflow: value.progress,
      };
    },
    (execution) => {
      execution.task.environment.allowIntervention = true;
    },
  );
  assert.equal(client.requests.length, 1);
  assert.match(report.summary, /第 2 次仍未核实甲类资格/);
  assert.deepEqual(
    report.steps.map((s) => s.status),
    ['BLOCKED', 'SKIPPED', 'SKIPPED'],
  );
});

// 范围：不同条件最多三轮交接，超过总上限保留剩余事项，不无限延长执行；无真实人工参与。
test('不同未解决条件也受整次执行三轮交接上限约束', async () => {
  const { report, client } = await run(
    (context, turn) => {
      const value = complete(context);
      value.progress.requirements[turn].status = 'incomplete';
      value.progress.requirements[turn].summary = `未确认条件 ${turn}`;
      return {
        type: 'verification.block',
        summary: `缺少条件 ${turn}`,
        workflow: value.progress,
      };
    },
    (execution) => {
      execution.task.environment.allowIntervention = true;
      execution.task.steps[0].policy = ['条件一', '条件二', '条件三', '条件四'];
    },
  );
  assert.equal(client.requests.length, 3);
  assert.match(report.summary, /未确认条件 4/);
  assert.equal(report.steps[2].status, 'SKIPPED');
});

// 范围：无进展保护仍保留最近具体未解决项，冻结截图属于当前执行，后续无 cleanup 覆盖；图片为证据元数据夹具。
test('准备停滞保存具体条件与阻塞时截图', async () => {
  const { report, client } = await run(
    (context, turn) => {
      const value = complete(context);
      const workflow = value.progress;
      workflow.requirements[1].status = 'incomplete';
      workflow.requirements[1].summary =
        '已登录，但未找到如何获得奖励页签，GitHub 绑定状态未确认';
      return turn === 1
        ? { type: 'browser.observe', workflow }
        : { type: 'browser.observe' };
    },
    (_execution, control) => {
      const command = control.command.bind(control);
      control.command = async (...args) => {
        const result = await command(...args);
        if (args[2].type === 'browser.observe' && args[2].screenshot) {
          const ref = {
            artifactId: 'blocked-screenshot',
            kind: 'SCREENSHOT',
            sha256: 'b'.repeat(64),
          };
          control.artifacts.push({
            id: ref.artifactId,
            kind: ref.kind,
            sha256: ref.sha256,
            state: 'AVAILABLE',
          });
          result.data.artifactRefs.push(ref);
        }
        return result;
      };
    },
  );
  assert.match(report.summary, /GitHub 绑定状态未确认/);
  assert.match(report.summary, /未找到如何获得奖励/);
  assert.equal(report.steps[0].blockage.conditions.length, 1);
  assert.ok(
    report.steps[0].blockage.evidenceRefs.includes('blocked-screenshot'),
  );
  assert.ok(report.steps[0].evidenceRefs.includes('blocked-screenshot'));
  assert.ok(report.artifacts.some((a) => a.id === 'blocked-screenshot'));
  assert.equal(report.steps[2].startedAt, null);
  assert.equal(client.requests.length, 0);
});

// 范围：截图取证失败不覆盖具体阻塞理由，也不继续业务或清理；不模拟真实节点截图质量。
test('截图失败保留原始原因和明确取证限制', async () => {
  const { report } = await run(
    () => ({ type: 'verification.block', summary: '绑定状态未知' }),
    (_execution, control) => {
      const command = control.command.bind(control);
      control.command = async (...args) => {
        if (args[2].screenshot)
          throw new Error('fixture screenshot unavailable');
        return command(...args);
      };
    },
  );
  assert.equal(report.executionDetails.reasonCode, 'ENVIRONMENT_NOT_READY');
  assert.match(report.summary, /绑定状态未知/);
  assert.equal(
    report.steps[0].blockage.screenshotError,
    'SCREENSHOT_UNAVAILABLE',
  );
  assert.equal(report.steps[2].status, 'SKIPPED');
});
