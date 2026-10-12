import assert from 'node:assert/strict';
import test from 'node:test';
import { compileStepBudget } from '../../contracts/dist/index.js';
import { execute } from '../../apps/agent/dist/execution/runner.js';
import { ChatModel } from '../../apps/agent/dist/model/chat.js';
import { Workflow } from '../../apps/agent/dist/execution/workflow.js';
import { legacyIdentityChecks } from '../../apps/agent/dist/execution/legacy-identity.js';
import {
  blockedLoginIntervention,
  needsLoginIntervention,
} from '../../apps/agent/dist/execution/login-intervention.js';
import { config, grant, FakeControl, finish, modelServer } from './fixture.mjs';

/** 页面、人工和账号均为夹具，记录完整交接状态以检验执行器是否真的等待并重新观察。 */
class LoginControl extends FakeControl {
  mode = 'AUTO';
  revision = 0;
  requests = [];
  transitions = [];
  resumed = false;
  restored = false;
  async view(execution) {
    return {
      ...(await super.view(execution)),
      controlMode: this.mode,
      controlRevision: this.revision,
    };
  }
  async command(...args) {
    const result = await super.command(...args);
    if (args[2].type === 'browser.observe') {
      result.data.url = 'https://example.test/referral';
      result.data.text = this.resumed
        ? '已登录，显示团队页面（人工处理后）'
        : this.restored
          ? '已登录，显示团队页面'
          : '公开活动页 Log In';
      result.data.targets =
        this.resumed || this.restored
          ? []
          : [
              {
                target: 'login',
                role: 'button',
                name: 'Log In',
                visible: true,
              },
            ];
    }
    return result;
  }
  async intervene(_execution, revision, reason, _signal, items, reasonCode) {
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
      this.resumed = true;
      this.mode = 'AUTO';
      this.transitions.push(this.mode);
      this.revision++;
    }, 10);
  }
}

/** 复现两类生产 case 的当前步骤，业务预期仍由输入决定；不连接真实控制面。 */
function loginGrant() {
  const execution = grant();
  execution.task.target.url = 'https://example.test/referral';
  execution.task.environment = {
    ...execution.task.environment,
    reuseAuth: true,
    allowIntervention: true,
  };
  execution.task.sessionPlan = {
    version: 1,
    mode: 'manual',
    candidates: [],
    requirements: [],
    preparationMs: 120000,
  };
  execution.task.steps = [
    {
      stepId: 'step-1',
      type: 'verification',
      url: execution.task.target.url,
      exec_order: 1,
      description: '使用已授权的测试团队子账号登录后查看邀请页',
      policy: ['账号必须为非团队所有者、未绑定 GitHub'],
      expected: ['显示简体中文'],
    },
  ];
  execution.task.acceptanceCriteria = [
    {
      id: 'step-1-expected-1',
      stepId: 'step-1',
      description: '检查文案',
      expectedResult: '显示简体中文',
      evidenceKinds: ['DOM'],
    },
  ];
  execution.task.stepBudget = compileStepBudget(execution.task);
  return execution;
}

/** 使用真实模型 HTTP 协议处理工具参数，返回正文由本地脚本生成。 */
async function runHandoff(decide, prepare = () => {}) {
  const execution = loginGrant();
  const client = new LoginControl();
  prepare(execution, client);
  const server = await modelServer((context, turn, body) =>
    decide(context, turn, body, client),
  );
  const settings = { ...config, modelUrl: server.url };
  try {
    const report = await execute(
      settings,
      client,
      new ChatModel(settings),
      execution,
    );
    assert.deepEqual(server.errors, []);
    return { report, client };
  } finally {
    await server.close();
  }
}

/** 模拟空验收项的准备步骤，完成仍须提交当前观察证据；不将夹具事实视为真实身份。 */
function setup(execution, description = '打开页面并准备验证') {
  Object.assign(execution.task.steps[0], {
    type: 'setup',
    description,
    policy: [],
    expected: [],
  });
  execution.task.acceptanceCriteria = [];
}

/** 提供当前步骤的新证据，覆盖 setup 和 cleanup 的执行完成协议。 */
function stepFinish(context, outcome) {
  const evidenceRefs = context.observation.artifactRefs.map(
    (ref) => ref.artifactId,
  );
  return {
    ...finish(context),
    evidenceRefs,
    ...(outcome
      ? {
          workflow: {
            assessments: [
              {
                stepId: context.executionStep.stepId,
                outcome,
                summary: '夹具明确声明当前步骤的完成状态',
                evidenceRefs,
              },
            ],
          },
        }
      : {}),
  };
}

// 范围：重放生产中的单步 incomplete/blocked+finish 矛盾决定；不评估模型自由文本的真假。
for (const outcome of ['incomplete', 'blocked']) {
  test(`单步 ${outcome} 不能被 finish 覆盖，补齐后才完成`, async () => {
    const { report, client } = await runHandoff(
      (context, turn) => {
        if (turn === 1) return stepFinish(context, outcome);
        assert.match(context.feedback, /WORKFLOW_INCOMPLETE/);
        assert.deepEqual(context.recordedCriteria, []);
        return stepFinish(context, 'complete');
      },
      (execution) => setup(execution),
    );
    assert.equal(report.steps[0].status, 'COMPLETED');
    assert.equal(client.requests.length, 0);
    assert.equal(report.executionDetails.modelCalls, 2);
  });
}

// 范围：单步旧协议可直接完成，但显式未完成不可绕过；多步骤完成门槛保持不变。
test('单步完成兼容直接声明，多步仍要求全部有完成证据', () => {
  const single = new Workflow('检查当前页面', 'step-1');
  single.assertFinish({ type: 'verification.finish' });
  single.apply(
    {
      assessments: [
        {
          stepId: 'step-1',
          outcome: 'incomplete',
          summary: '尚未确认角色',
          evidenceRefs: [],
        },
      ],
    },
    new Set(),
  );
  assert.throws(() => single.assertFinish({ type: 'verification.finish' }), {
    code: 'WORKFLOW_INCOMPLETE',
  });
  const multi = new Workflow('1. 查看页面\n2. 验证结果');
  assert.throws(() => multi.assertFinish({ type: 'verification.finish' }), {
    code: 'WORKFLOW_INCOMPLETE',
  });
});

// 范围：拒绝矛盾 finish 时不提前保存其 PASSED 验收项；证据与模型回复均为夹具。
test('未完成的验证步骤不能提前写入通过结论', async () => {
  const { report, client } = await runHandoff((context, turn) => {
    if (turn === 1) return stepFinish(context, 'incomplete');
    assert.deepEqual(context.recordedCriteria, []);
    return {
      type: 'verification.block',
      reasonCode: 'OTHER',
      summary: '当前业务条件不满足',
    };
  });
  assert.equal(report.steps[0].status, 'BLOCKED');
  assert.deepEqual(report.steps[0].criteria, []);
  assert.ok(
    client.stepSnapshots.every((steps) => steps[0].criteria.length === 0),
  );
});

// 范围：持续矛盾完成声明可交接一次，人工返回仍不自动认可；不验证真人如何补齐条件。
test('人工返回仍声明单步 incomplete 时有界受阻', async () => {
  const { report, client } = await runHandoff(
    (context) => stepFinish(context, 'incomplete'),
    (execution) => setup(execution),
  );
  assert.equal(client.requests.length, 1);
  assert.equal(report.steps[0].reasonCode, 'WORKFLOW_INCOMPLETE');
  assert.equal(report.steps[0].status, 'BLOCKED');
});

// 范围：旧 Schema 的角色/绑定原文先交人工核实，跨业务步继承同代次确认，结果仍可失败；不验证真实团队权限。
test('已恢复登录也须核实旧 Schema 账号条件，后续业务不能靠 OTHER 绕过', async () => {
  const { report, client } = await runHandoff(
    (context, _turn, _body, control) => {
      assert.equal(control.requests.length, 1);
      assert.ok(context.preconditions.length > 0);
      assert.ok(
        context.preconditions.every(
          (check) =>
            check.status === 'SATISFIED' &&
            check.source === 'human' &&
            check.controlRevision === 2,
        ),
      );
      if (context.executionStep.stepId === 'step-1')
        return stepFinish(context, 'complete');
      return {
        type: 'verification.block',
        reasonCode: 'OTHER',
        summary: '资格已由人工确认，但当前业务区块确实缺失',
      };
    },
    (execution, control) => {
      control.restored = true;
      const verification = { ...execution.task.steps[0], stepId: 'step-2' };
      setup(execution, '使用已授权测试团队子账号登录后查看邀请页');
      execution.task.steps[0].policy = [
        '仅使用非团队所有者、未绑定 GitHub 的测试账号',
      ];
      execution.task.steps.push(verification);
      execution.task.stepBudget = compileStepBudget(execution.task);
    },
  );
  assert.equal(client.requests[0].reasonCode, 'IDENTITY_CHECK_UNMET');
  assert.match(
    client.requests[0].items.join(' '),
    /非团队所有者、未绑定 GitHub/,
  );
  assert.equal(client.requests.length, 1);
  assert.equal(report.steps[0].status, 'COMPLETED');
  assert.equal(report.steps[1].status, 'BLOCKED');
  assert.equal(report.executionDisposition, 'BLOCKED');
  assert.equal(
    client.calls.filter((c) => c.operation.action === 'navigate').length,
    1,
  );
});

// 范围：辅助关闭时，未确认账号资格在调用模型前受阻；不通过文字“个人”推断真实账号角色。
test('未授权人工时账号前置条件不能被模型放行', async () => {
  const { report, client } = await runHandoff(
    () => {
      throw new Error('不应进入模型');
    },
    (execution, control) => {
      setup(execution, '使用未绑定 GitHub 的已授权测试账号登录后打开页面');
      execution.task.environment.allowIntervention = false;
      control.restored = true;
    },
  );
  assert.equal(report.steps[0].reasonCode, 'PRECONDITION_UNMET');
  assert.equal(report.steps[0].preconditions[0].status, 'UNCONFIRMED');
  assert.equal(client.requests.length, 0);
});

// 范围：旧文本只补齐准备阶段资格，显式身份配置、访客、清理、普通登录及页面文案不会被重新解释。
test('账号条件兼容层保留明确配置与任务边界', () => {
  const execution = loginGrant();
  setup(execution, '使用非团队所有者账号登录');
  assert.ok(legacyIdentityChecks(execution.task, 0).length);
  const variants = [
    (task) => {
      task.sessionPlan.mode = 'guest';
    },
    (task) => {
      task.cleanupStepIds = ['step-1'];
    },
    (task) => {
      task.steps[0].description = '退出登录并清除登录态';
    },
    (task) => {
      task.steps[0].description = '保持未登录访客状态查看团队成员介绍';
    },
    (task) => {
      task.steps[0].description =
        '登录后查看团队账户提示，不绑定真实第三方账号';
    },
    (task) => {
      task.steps[0].preconditions = [
        {
          id: 'explicit',
          description: '指定团队',
          method: 'text',
          value: '测试团队',
        },
      ];
    },
    (task) => {
      task.sessionPlan.requirements = [
        { id: 'explicit', description: '指定角色', method: 'manual' },
      ];
    },
    (task) => {
      task.sessionPlan.candidates = [
        {
          checks: [
            { id: 'account', description: '账号池指定资格', method: 'manual' },
          ],
        },
      ];
    },
  ];
  for (const change of variants) {
    const task = structuredClone(execution.task);
    change(task);
    assert.deepEqual(legacyIdentityChecks(task, 0), []);
  }
  execution.task.steps.push({
    ...execution.task.steps[0],
    stepId: 'step-2',
    type: 'verification',
    url: 'https://other.test/',
  });
  assert.deepEqual(legacyIdentityChecks(execution.task, 1), []);
  execution.task.steps[1] = {
    ...execution.task.steps[0],
    stepId: 'step-2',
    description: '使用团队成员账号登录',
  };
  const changed = legacyIdentityChecks(execution.task, 1);
  assert.equal(changed.length, 1);
  assert.equal(changed[0].description, '使用团队成员账号登录');
  assert.notEqual(changed[0].id, legacyIdentityChecks(execution.task, 0)[0].id);
});

// 范围：超过交接协议容量时明确受阻，不截断或默认确认遗漏条件；不验证真实账号清单。
test('过长账号确认清单不能被截断后整体认可', async () => {
  const { report, client } = await runHandoff(
    () => {
      throw new Error('不应进入模型');
    },
    (execution) => {
      setup(execution);
      execution.task.steps[0].policy = Array.from(
        { length: 11 },
        (_, index) => `要求账号角色为测试角色 ${index}`,
      );
    },
  );
  assert.equal(report.steps[0].reasonCode, 'PRECONDITION_UNMET');
  assert.equal(client.requests.length, 0);
});

// 范围：纯观察重试与两个状态间循环均触发一次恢复，显式访客只得到通用辅助；不连接真实站点。
for (const mode of ['observe', 'cycle']) {
  test(`不同无进展入口保留访客边界：${mode}`, async () => {
    const { report, client } = await runHandoff(
      (context, turn, _body, control) => {
        if (control.resumed) return stepFinish(context);
        return mode === 'observe'
          ? { type: 'browser.observe' }
          : {
              type: 'browser.act',
              action: 'scroll',
              value: turn % 2 ? 'down' : 'up',
            };
      },
      (execution, control) => {
        setup(execution, '保持未登录访客状态，查找当前页面目标区块');
        execution.task.sessionPlan.mode = 'guest';
        let state = false;
        const command = control.command.bind(control);
        control.command = async (...args) => {
          if (args[2].action === 'scroll') state = !state;
          const result = await command(...args);
          if (
            args[2].type === 'browser.observe' &&
            mode === 'cycle' &&
            !control.resumed
          )
            result.data.text = state ? '页面上部' : '页面下部';
          return result;
        };
      },
    );
    assert.equal(client.requests.length, 1);
    assert.equal(client.requests[0].reasonCode, 'GENERAL');
    assert.match(client.requests[0].items.join(' '), /未登录访客/);
    assert.equal(report.steps[0].status, 'COMPLETED');
  });
}

// 范围：未知副作用不是可恢复的页面无进展，不能交接后重复写入；未知效果仅由夹具注入。
test('未知操作效果不能被通用辅助恢复', async () => {
  const { report, client } = await runHandoff(
    () => ({ type: 'browser.act', action: 'click', target: 'login' }),
    (_execution, control) => {
      control.unknown = true;
    },
  );
  assert.equal(client.requests.length, 0);
  assert.equal(report.steps[0].reasonCode, 'BROWSER_EFFECT_UNKNOWN');
  assert.equal(
    client.calls.filter((call) => call.operation.action === 'click').length,
    1,
  );
});

// 范围：业务和清理无进展均交接一次，恢复读取新页面并继续原步；不验证真实浏览器、人工操作或登出。
for (const cleanup of [false, true]) {
  test(`无进展交接后重新观察并保留动作预算：${cleanup ? '清理' : '业务'}`, async () => {
    let before;
    const { report, client } = await runHandoff(
      (context, _turn, _body, control) => {
        if (!control.resumed) {
          before = context.budgetRemaining.actions;
          return { type: 'browser.act', action: 'scroll', value: 'down' };
        }
        assert.ok(context.budgetRemaining.actions < before);
        assert.equal(context.executionStep.stepId, 'step-1');
        assert.match(context.observation.text, /人工处理后/);
        return stepFinish(context);
      },
      (execution, control) => {
        setup(
          execution,
          cleanup ? '退出登录并清除登录态' : '寻找当前页面指定区块',
        );
        if (cleanup) execution.task.cleanupStepIds = ['step-1'];
        control.restored = true;
        execution.task.stepBudget = compileStepBudget(execution.task);
      },
    );
    assert.equal(client.requests.length, 1);
    assert.equal(client.requests[0].reasonCode, 'GENERAL');
    assert.deepEqual(client.transitions, ['REQUESTED', 'HUMAN', 'AUTO']);
    assert.equal(report.steps[0].status, 'COMPLETED');
    assert.equal(
      client.calls.filter((c) => c.operation.action === 'navigate').length,
      1,
    );
  });
}

// 范围：辅助关闭不交接，人工无法解决仍有界受阻，显式重复介入也不能续杯；不模拟业务页面恢复率。
for (const mode of [
  'disabled',
  'stalled-again',
  'intervene-again',
  'login-block-again',
]) {
  test(`无进展辅助有界：${mode}`, async () => {
    const { report, client } = await runHandoff(
      (_context, _turn, _body, control) =>
        control.resumed && mode === 'login-block-again'
          ? {
              type: 'verification.block',
              reasonCode: 'LOGIN_REQUIRED',
              summary: '通用辅助后仍缺少登录条件',
            }
          : control.resumed && mode === 'intervene-again'
            ? { type: 'verification.intervene', reason: '页面仍无法操作' }
            : { type: 'browser.act', action: 'scroll', value: 'down' },
      (execution) => {
        setup(execution, '寻找当前页面指定区块');
        execution.task.environment.allowIntervention = mode !== 'disabled';
        execution.task.stepBudget.steps[0].maxActions = 30;
      },
    );
    assert.equal(client.requests.length, mode === 'disabled' ? 0 : 1);
    assert.equal(
      report.steps[0].reasonCode,
      mode === 'login-block-again' ? 'MODEL_BLOCKED' : 'NO_PROGRESS',
    );
    assert.equal(report.steps[0].status, 'BLOCKED');
  });
}

// 范围：活动页无密码框时，旧模型和结构化登录/角色阻塞均经过 REQUESTED/HUMAN/AUTO 后继续当前步；不验证真人或 Cookie。
for (const reasonCode of [
  undefined,
  'LOGIN_REQUIRED',
  'IDENTITY_UNCONFIRMED',
]) {
  test(`登录受阻先交接再验收：${reasonCode ?? '兼容旧回复'}`, async () => {
    const { report, client } = await runHandoff(
      (context, turn, body, control) => {
        if (turn === 1) {
          assert.equal(control.requests.length, 0);
          assert.ok(
            body.tools.find((t) => t.function.name === 'verification_block')
              .function.parameters.properties.reasonCode,
          );
          return {
            type: 'verification.block',
            summary: '缺少登录态或账号角色无法确认',
            ...(reasonCode ? { reasonCode } : {}),
          };
        }
        assert.equal(control.resumed, true);
        assert.equal(context.executionStep.stepId, 'step-1');
        assert.match(context.observation.text, /已登录/);
        return finish(context);
      },
    );
    assert.equal(report.verdict, 'PASSED');
    assert.equal(report.steps[0].status, 'COMPLETED');
    assert.equal(client.requests.length, 1);
    assert.deepEqual(client.transitions, ['REQUESTED', 'HUMAN', 'AUTO']);
    assert.match(client.requests[0].items.join(' '), /非团队所有者/);
    assert.equal(
      client.requests[0].reasonCode,
      reasonCode === 'IDENTITY_UNCONFIRMED'
        ? 'IDENTITY_CHECK_UNMET'
        : 'LOGIN_REQUIRED',
    );
    assert.equal(
      client.calls.filter((c) => c.operation.action === 'navigate').length,
      1,
    );
  });
}

// 范围：人工交还不等于业务通过，重复登录阻塞或重复登录介入最多请求一次；不验证真实角色识别。
for (const again of ['verification.block', 'verification.intervene']) {
  test(`人工仍无法解决时有界结束：${again}`, async () => {
    const { report, client } = await runHandoff((_context, turn) =>
      turn === 1 || again === 'verification.block'
        ? {
            type: 'verification.block',
            summary: '账号资格仍不满足',
            reasonCode: 'IDENTITY_UNCONFIRMED',
          }
        : { type: 'verification.intervene', reason: '还需要登录' },
    );
    assert.equal(client.requests.length, 1);
    assert.equal(report.executionDisposition, 'BLOCKED');
    assert.equal(report.verdict, null);
  });
}

// 范围：未授权辅助、显式访客、自然语言访客、清理及其他原因不能扩大为登录；模型与页面均为夹具。
for (const mode of ['disabled', 'guest', 'guest-text', 'cleanup', 'other']) {
  test(`交接保留权限与业务边界：${mode}`, async () => {
    const { report, client } = await runHandoff(
      () => ({
        type: 'verification.block',
        summary: '夹具阻塞',
        reasonCode: mode === 'other' ? 'OTHER' : 'LOGIN_REQUIRED',
      }),
      (execution) => {
        if (mode === 'disabled')
          execution.task.environment.allowIntervention = false;
        if (mode === 'guest') execution.task.sessionPlan.mode = 'guest';
        if (mode === 'guest-text')
          execution.task.steps[0].description = '保持未登录访客状态查看页面';
        if (mode === 'cleanup') execution.task.cleanupStepIds = ['step-1'];
      },
    );
    assert.equal(client.requests.length, 0);
    if (mode !== 'cleanup')
      assert.equal(report.executionDisposition, 'BLOCKED');
    if (mode === 'disabled')
      assert.equal(report.executionDetails.reasonCode, 'INTERVENTION_DISABLED');
  });
}

// 范围：复用后的有效页面无需人工，普通导航按钮不在模型决策前强制接管；不证明真实 Cookie 恢复有效。
test('有效登录继续验收，登录按钮本身不触发人工', async () => {
  const { report, client } = await runHandoff(
    (context) => finish(context),
    (_execution, control) => {
      control.restored = true;
    },
  );
  assert.equal(report.verdict, 'PASSED');
  assert.equal(client.requests.length, 0);
  const execution = loginGrant();
  const page = {
    url: execution.task.target.url,
    targets: [{ role: 'button', name: 'Log In', visible: true }],
  };
  assert.equal(needsLoginIntervention(execution.task, page, 0), false);
  assert.equal(
    blockedLoginIntervention(
      execution.task,
      {
        ...page,
        targets: [{ role: 'button', name: 'Log In', visible: false }],
      },
      0,
      { type: 'verification.block', summary: '旧回复' },
    ),
    false,
  );
});
