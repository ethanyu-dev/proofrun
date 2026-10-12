import assert from 'node:assert/strict';
import test from 'node:test';
import { compileStepBudget } from '../../contracts/dist/index.js';
import { execute } from '../../apps/agent/dist/execution/runner.js';
import { ChatModel } from '../../apps/agent/dist/model/chat.js';
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
      result.data.text =
        this.resumed || this.restored
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
