import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compileStepBudget,
  compileProfilePlan,
} from '../../contracts/dist/index.js';
import { execute } from '../../packages/execution-driver/dist/execution/runner.js';
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
    evidenceRefs: context.page.artifactRefs.map((ref) => ref.artifactId),
  };
}

/** 每个组两步且共用一个执行，页面事实仍是模拟数据，不代表真实站点环境通过。 */
function profileGrant(ids = ['a', 'b']) {
  const execution = grant();
  execution.task.steps = ids.flatMap((id) => [
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
  execution.task.acceptanceCriteria = ids.map((id) => ({
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
async function run(
  decide,
  prepare = () => {},
  client = new FakeControl(),
  ids,
) {
  const execution = profileGrant(ids);
  prepare(execution);
  if (
    execution.task.profilePlan.environmentGateStepId &&
    !execution.task.executionPlan
  )
    execution.task.executionPlan = {
      version: 1,
      environment: {
        mode:
          execution.task.sessionPlan?.mode === 'manual' ||
          execution.task.sessionPlan?.mode === 'guest'
            ? 'guest'
            : 'configured',
        source: 'explicit',
        basis: [],
        resolverVersion: 1,
      },
      evidenceKinds: ['DOM'],
    };
  const seen = [];
  const server = await modelServer(async (context) => {
    seen.push([context.task.stepId, context.state.phase]);
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
    if (context.state.phase === 'PREPARING') {
      assert.deepEqual(
        context.task.requirements.map((s) => s.requirementRef),
        ['task.description'],
      );
      await new Promise((resolve) => {
        waiting.push(resolve);
        if (waiting.length === 2) waiting.forEach((done) => done());
      });
    }
    if (context.state.phase === 'CHECKING')
      assert.deepEqual(
        context.task.requirements.map((s) => s.requirementRef),
        context.task.policy.map((_, i) => `task.policy[${i}]`),
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

// 范围：八组模型请求重叠、第九组等待名额、浏览器命令串行及清理屏障；不代表真实模型配额或 Chromium 性能。
test('八组同时启动，第九组等待完成名额且浏览器命令不重叠', async () => {
  const waiting = [];
  const prepared = new Set();
  const verified = new Set();
  let commands = 0;
  let maxCommands = 0;
  const client = new FakeControl();
  const command = client.command.bind(client);
  client.command = async (...args) => {
    maxCommands = Math.max(maxCommands, ++commands);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return await command(...args);
    } finally {
      commands--;
    }
  };
  const ids = Array.from({ length: 9 }, (_, i) => `case-${i + 1}`);
  const { report, seen } = await run(
    async (context) => {
      const id = context.task.stepId;
      if (
        context.state.phase === 'PREPARING' &&
        !(context.state.phase === 'CLEANUP')
      ) {
        prepared.add(id);
        if (id === 'case-9-setup') {
          assert.equal(prepared.size, 9);
          assert(verified.size > 0, '第九组必须等前面的组完成验证');
        } else {
          assert.equal(verified.size, 0);
          await new Promise((resolve) => {
            waiting.push(resolve);
            if (waiting.length === 8) waiting.forEach((done) => done());
          });
        }
      }
      if (context.state.phase === 'VERIFYING') verified.add(id);
      if (context.state.phase === 'CLEANUP') assert.equal(verified.size, 9);
      return finish(context);
    },
    () => {},
    client,
    ids,
  );
  assert.equal(report.verdict, 'PASSED', report.summary);
  assert.equal(waiting.length, 8);
  assert.equal(verified.size, 9);
  assert.equal(maxCommands, 1);
  assert.equal(seen.at(-1)[0], 'cleanup');
  assert.deepEqual(
    report.steps.map((s) => s.status),
    Array(19).fill('COMPLETED'),
  );
  assert.equal(new Set(client.calls.map((c) => c.operation.tabScope)).size, 10);
});

// 范围：共享网络或跟踪证据要求整个组串行，即使计划允许八组；只检查调度，不验证网络证据内容。
for (const kind of ['NETWORK', 'TRACE']) {
  test(`${kind} 证据任务在高并发计划下仍逐组执行`, async () => {
    const ids = Array.from({ length: 8 }, (_, i) => `case-${i + 1}`);
    const visited = [];
    await run(
      (context) => {
        const id = context.task.stepId;
        if (id !== 'cleanup' && visited.at(-1) !== id) visited.push(id);
        return finish(context);
      },
      (execution) => {
        assert.equal(execution.task.profilePlan.maxConcurrency, 8);
        execution.task.acceptanceCriteria[0].evidenceKinds.push(kind);
      },
      new FakeControl(),
      ids,
    );
    assert.deepEqual(
      visited,
      ids.flatMap((id) => [`${id}-setup`, `${id}-verify`]),
    );
  });
}

// 范围：一个组 policy 失败只跳过本组验证，阻塞证据保留且禁止清理；不验证真实业务权限。
test('分组不符合环境不阻止兄弟组，并禁止整个 profile 的 cleanup', async () => {
  const { report, client, seen } = await run((context) =>
    context.task.stepId === 'a-setup' && context.state.phase === 'CHECKING'
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
          context.task.stepId === 'a-setup' &&
          context.state.phase === 'CHECKING'
        ) {
          if (!requested) {
            requested = true;
            return { type: 'verification.block', summary: '需要人工确认资格' };
          }
          const confirmed = context.state.requirements.every(
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
        context.task.stepId === 'a-setup' &&
        context.state.phase === 'CHECKING' &&
        !asked
      ) {
        await started;
        asked = true;
        return { type: 'verification.block', summary: '人工确认甲组资格' };
      }
      if (
        context.task.stepId === 'b-setup' &&
        context.state.phase === 'CHECKING'
      )
        bChecks++;
      if (context.task.stepId === 'b-verify' && bFirst) {
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

// 范围：分组人工会话无需本地准备命令，各组仍进入自己的入口；不验证真实登录。
test('profile 分组直接执行且不读取本地身份配方', async () => {
  const { report, client } = await run(finish, (execution) => {
    execution.task.sessionPlan = {
      version: 1,
      mode: 'manual',
      preparationMs: 120000,
      requirements: [],
      candidates: [],
    };
    execution.task.steps[0].url = 'http://intranet.test/another';
  });
  assert.ok(
    !client.calls.some((c) => c.operation.type === 'browser.identity.prepare'),
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
      if (context.state.phase === 'CHECKING')
        assert.deepEqual(context.task.criteria, []);
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

// 范围：冻结访客必须有当前会话空白来源证明；不以模型声明或人工勾选替代节点事实。
test('共享访客缺少节点准备证明时不调度兄弟组', async () => {
  const { report, seen } = await run(finish, (execution) => {
    execution.task.profilePlan.environmentGateStepId = 'a-setup';
    execution.task.sessionPlan = {
      version: 1,
      mode: 'guest',
      candidates: [],
      requirements: [],
      preparationMs: 120000,
    };
  });
  assert.equal(report.steps[0].reasonCode, 'ENVIRONMENT_PROOF_MISSING');
  assert(report.steps.slice(1).every((s) => s.status === 'SKIPPED'));
  assert.equal(seen.length, 0);
});

// 范围：首门禁只串行共享准备，READY 后首组验证与兄弟组准备可重叠；不测物理浏览器吞吐。
test('首门禁 READY 后恢复分组并发', async () => {
  const waiting = [];
  const { report } = await run(
    async (context) => {
      if (context.environmentReview?.required)
        return {
          type: 'verification.environment',
          mode: 'configured',
          summary: '无访客要求',
        };
      if (
        context.task.stepId === 'a-verify' ||
        (context.task.stepId === 'b-setup' &&
          context.state.phase === 'PREPARING')
      ) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('门禁后没有恢复并发')),
            2000,
          );
          waiting.push(() => {
            clearTimeout(timer);
            resolve();
          });
          if (waiting.length === 2) waiting.forEach((done) => done());
        });
      }
      return finish(context);
    },
    (execution) => {
      execution.task.profilePlan.environmentGateStepId = 'a-setup';
    },
  );
  assert.equal(report.verdict, 'PASSED', report.summary);
  assert.equal(waiting.length, 2);
});

// 范围：显式访客配置优先，隔离会话不额外请求人工；真实不恢复认证由节点已有集成测试验证。
test('显式 guest 冻结后不提供环境改写工具', async () => {
  const client = new FakeControl();
  const view = client.view.bind(client);
  client.view = async (execution) => ({
    ...(await view(execution)),
    environmentProof: {
      sessionId: execution.sessionId,
      initialState: 'empty',
      authRestored: false,
    },
  });
  const { report } = await run(
    (context) => {
      if (context.environmentReview?.required)
        return {
          type: 'verification.environment',
          mode: 'configured',
          summary: '夹具尝试覆盖配置',
        };
      if (context.environmentReview)
        assert.equal(context.environmentReview.mode, 'guest');
      return finish(context);
    },
    (execution) => {
      execution.task.profilePlan.environmentGateStepId = 'a-setup';
      execution.task.sessionPlan = {
        version: 1,
        mode: 'guest',
        candidates: [],
        requirements: [],
        preparationMs: 120000,
      };
    },
    client,
  );
  assert.equal(report.verdict, 'PASSED', report.summary);
});

// 范围：旧环境分类工具不再被执行器接受，不能改变冻结身份；不验证真实模型遵从性。
test('旧环境分类工具不能改写冻结账号意图', async () => {
  const { report } = await run(
    () => ({
      type: 'verification.environment',
      mode: 'guest',
      summary: '覆盖环境',
    }),
    (execution) => {
      execution.task.profilePlan.environmentGateStepId = 'a-setup';
    },
  );
  assert.equal(report.steps[0].reasonCode, 'INVALID_MODEL_DECISION');
  assert(report.steps.slice(1).every((s) => s.status === 'SKIPPED'));
});

// 范围：读取进度随阻塞持久化且证据属于步骤；浏览器面板和原文均为夹具。
for (const completed of [false, true])
  test(`FAQ 读取在${completed ? '完成' : '阻塞'}报告中保留独立证据`, async () => {
    const client = new FakeControl();
    const command = client.command.bind(client);
    client.command = async (...args) => {
      const result = await command(...args);
      if (args[2].type === 'browser.observe')
        result.data.targets.push({
          target: '@faq',
          comparisonKey: 'faq-1',
          role: 'button',
          name: '问题一',
          context: { heading: 'FAQ', fixed: false },
          disclosure: {
            relation: 'aria-controls',
            expanded: true,
            visible: true,
            text: '第一条答案已显示',
            truncated: false,
          },
        });
      return result;
    };
    const { report } = await run(
      (context) => {
        if (
          context.task.stepId === 'a-verify' &&
          context.state.readings.items[0].status !== 'recorded'
        )
          return {
            type: completed ? 'browser.observe' : 'verification.block',
            ...(completed ? {} : { summary: '第二个问题无法定位' }),
            workflow: {
              readings: [
                {
                  itemId: context.state.readings.items[0].id,
                  quote: '第一条答案已显示',
                },
              ],
            },
          };
        return finish(context);
      },
      () => {},
      client,
    );
    const result = report.steps[1];
    assert.equal(result.status, completed ? 'COMPLETED' : 'BLOCKED');
    assert.equal(result.readings[0].status, 'recorded');
    assert.equal(result.readings[0].quote, '第一条答案已显示');
    assert(
      result.readings[0].evidenceRefs.every((id) =>
        result.evidenceRefs.includes(id),
      ),
    );
    assert.equal(report.steps[3].status, 'COMPLETED');
  });

/** 新版控制面夹具，空白证明和网络数据仅用于验证执行器分支，不代表真实节点采集。 */
class PlannedControl extends HumanControl {
  authRevision = 0;
  networkStatus;
  restoreProof = false;
  async view(execution) {
    const view = await super.view(execution);
    return {
      ...view,
      authRevision: this.authRevision,
      environmentProof: {
        sessionId: execution.sessionId,
        initialState: this.restoreProof ? 'restored' : 'empty',
        authRestored: this.restoreProof,
      },
      humanConfirmation: this.confirmation
        ? {
            ...this.confirmation,
            authRevision: this.authRevision,
            conditionKeys: this.confirmedKeys ?? [],
          }
        : undefined,
    };
  }
  async intervene(
    execution,
    revision,
    reason,
    signal,
    items,
    reasonCode,
    keys,
  ) {
    await super.intervene(
      execution,
      revision,
      reason,
      signal,
      items,
      reasonCode,
    );
    this.confirmedKeys = [
      ...new Set([...(this.confirmedKeys ?? []), ...(keys ?? [])]),
    ];
  }
  async command(...args) {
    const result = await super.command(...args);
    if (
      args[2].type === 'browser.observe' &&
      this.networkStatus !== undefined
    ) {
      const artifact = {
        id: `network-${this.artifacts.length}`,
        kind: 'NETWORK',
        sha256: 'b'.repeat(64),
        state: 'AVAILABLE',
      };
      this.artifacts.push(artifact);
      result.data.artifactRefs.push({
        artifactId: artifact.id,
        kind: 'NETWORK',
        sha256: artifact.sha256,
      });
      result.data.network = {
        scope: 'tab-navigation',
        navigationId: 'current',
        requests: [
          {
            url: new URL('/api', result.data.url).href,
            status: this.networkStatus,
            navigationId: 'current',
          },
        ],
      };
    }
    return result;
  }
}
/** 仅为协议测试补齐冻结配置，真实配置编译另由 API 测试覆盖。 */
function planned(execution, network = false) {
  execution.task.environment.allowIntervention = true;
  execution.task.executionPlan = {
    version: 1,
    environment: {
      mode: 'guest',
      source: 'explicit',
      basis: [],
      resolverVersion: 1,
    },
    evidenceKinds: network ? ['DOM', 'NETWORK'] : ['DOM'],
  };
  execution.task.sessionPlan = {
    version: 1,
    mode: 'guest',
    preparationMs: 120000,
    requirements: [],
    candidates: [],
  };
  if (network)
    execution.task.steps[0].policyChecks = [
      {
        id: 'response',
        description: '接口成功',
        policyIndex: 0,
        method: 'networkResponse',
        path: '/api',
        statusMin: 200,
        statusMax: 299,
      },
    ];
}

// 范围：错误的权限阻塞得到一次复核，语言操作仍由模型选择并经过两阶段门禁；页面、账号和模型均为夹具。
test('准备阶段可以自行切换指定语言，过早 OTHER 阻塞只复核一次', async () => {
  const client = new PlannedControl();
  const command = client.command.bind(client);
  let chinese = false;
  client.command = async (...args) => {
    if (args[2].action === 'click' && args[2].target === '@language')
      chinese = true;
    const result = await command(...args);
    if (args[2].type === 'browser.observe') {
      result.data.text = chinese ? '简体中文活动页' : 'English activity page';
      result.data.targets = [
        {
          target: '@language',
          role: 'button',
          name: '简体中文',
          operations: ['click'],
        },
      ];
      result.data.documents = [
        {
          url: result.data.url,
          isMainFrame: true,
          frameId: 'main',
          lang: chinese ? 'zh-CN' : 'en',
        },
      ];
    }
    return result;
  };
  let reviews = 0;
  let blockedOnce = false;
  const { report, seen } = await run(
    (context) => {
      if (context.state.phase === 'PREPARING' && !chinese) {
        if (!blockedOnce) {
          blockedOnce = true;
          return {
            type: 'verification.block',
            reasonCode: 'OTHER',
            summary: '语言不符，担心切换越权',
          };
        }
        assert.match(
          context.feedback.map((item) => item.message ?? item.code).join(' '),
          /PREPARATION_REVIEW/,
        );
        assert(
          context.state.conditions
            .filter((item) => item.scope === 'current')
            .map(({ scope: _scope, ...item }) => item)
            .some((p) => p.id === 'platform-guest' && p.status === 'SATISFIED'),
        );
        reviews++;
        return { type: 'browser.act', action: 'click', target: '@language' };
      }
      return finish(context);
    },
    (execution) => {
      planned(execution);
      execution.task.steps[0].description =
        '以未登录访客打开页面，切换简体中文并核对 html lang=zh-CN';
    },
    client,
    ['a'],
  );
  assert.equal(report.verdict, 'PASSED', report.summary);
  assert.equal(reviews, 1);
  assert.equal(client.requests.length, 0);
  assert(seen.some(([, phase]) => phase === 'CHECKING'));
  assert.equal(
    client.calls.filter((call) => call.operation.action === 'click').length,
    1,
  );
});

// 范围：复核后仍无法准备必须停止，不无限重试或放行业务；不验证真实站点故障分类。
test('准备阻塞复核不把真实缺口变成自动通过', async () => {
  const client = new PlannedControl();
  const command = client.command.bind(client);
  client.command = async (...args) => {
    const result = await command(...args);
    if (args[2].type === 'browser.observe')
      result.data.targets[0].operations = ['fill'];
    return result;
  };
  let calls = 0;
  const { report, seen } = await run(
    () => {
      calls++;
      return {
        type: 'verification.block',
        reasonCode: 'OTHER',
        summary: '目标语言入口不可用',
      };
    },
    (execution) => planned(execution),
    client,
    ['a'],
  );
  assert.equal(calls, 2);
  assert.equal(report.steps[0].reasonCode, 'SETUP_BLOCKED');
  assert(!seen.some(([step]) => step === 'a-verify'));
  assert.equal(client.requests.length, 0);
});

// 范围：新 plan 不再让模型分类访客、空白证明支持免交接、错误证明阻塞；不验收生产登录态。
for (const restored of [false, true])
  test(`冻结访客与节点准备证明 ${restored ? '不符' : '一致'}`, async () => {
    const client = new PlannedControl();
    client.restoreProof = restored;
    const { report, seen } = await run(
      (context) => finish(context),
      (execution) => planned(execution),
      client,
      ['a'],
    );
    assert.equal(client.requests.length, 0);
    assert.equal(
      report.executionDisposition,
      restored ? 'BLOCKED' : 'EXECUTED',
      report.summary,
    );
    if (restored) {
      assert.equal(report.steps[0].reasonCode, 'ENVIRONMENT_PROOF_MISSING');
      assert.equal(seen.length, 0);
    }
  });

// 范围：当前导航接口证据决定固定检查、补证据反馈不触发 HITL，模型 complete 不能绕过；网络由夹具提供。
for (const available of [true, false])
  test(`固定接口证据 ${available ? '满足' : '缺失'} 时的完整 setup 流程`, async () => {
    const client = new PlannedControl();
    if (available) client.networkStatus = 200;
    let feedbackSeen = false;
    const { report } = await run(
      (context) => {
        if (
          context.feedback
            .map((item) => item.message ?? item.code)
            .join(' ')
            ?.includes('先补充')
        )
          feedbackSeen = true;
        return finish(context);
      },
      (execution) => planned(execution, true),
      client,
      ['a'],
    );
    assert.equal(client.requests.length, 0);
    assert.equal(
      report.executionDisposition,
      available ? 'EXECUTED' : 'BLOCKED',
      report.summary,
    );
    if (!available) {
      assert(feedbackSeen);
      assert.equal(report.steps[0].reasonCode, 'POLICY_EVIDENCE_INCOMPLETE');
    } else
      assert(
        report.steps[0].preconditions.some(
          (item) =>
            item.id.startsWith('policy-') && item.status === 'SATISFIED',
        ),
      );
  });

// 范围：仅漏交 workflow 声明时返回一次纠正机会，不把格式补齐交给人工；不验证模型泛化表现。
test('新计划第一次缺项 finish 可以修正后通过', async () => {
  const client = new PlannedControl();
  let missing = true;
  const { report } = await run(
    (context) => {
      const result = finish(context);
      if (context.state.phase === 'CHECKING' && missing) {
        missing = false;
        delete result.workflow;
      }
      return result;
    },
    (execution) => planned(execution),
    client,
    ['a'],
  );
  assert.equal(report.executionDisposition, 'EXECUTED', report.summary);
  assert.equal(client.requests.length, 0);
});

// 范围：两次交接后身份与原始原因可追溯，第二次纯查看不撤销第一次稳定确认；不保证人工声明真实。
test('同认证版本的人工确认跨交接保留且待办包含访客复核', async () => {
  const client = new PlannedControl();
  let calls = 0;
  const { report } = await run(
    (context) => {
      if (context.state.phase === 'CHECKING' && calls++ < 2)
        return {
          type: 'verification.intervene',
          reason: '请核实资格',
          reasonCode: 'IDENTITY_UNCONFIRMED',
          items: ['确认资格'],
          workflow: {
            assessments: context.state.requirements.map((item, index) => ({
              stepId: item.id,
              outcome:
                index === client.requests.length ? 'blocked' : 'complete',
              summary: '夹具条件',
              evidenceRefs: context.page.artifactRefs.map(
                (ref) => ref.artifactId,
              ),
            })),
          },
        };
      return finish(context);
    },
    (execution) => {
      planned(execution);
      execution.task.steps[0].policy = ['资格甲', '资格乙'];
    },
    client,
    ['a'],
  );
  assert.equal(report.executionDisposition, 'EXECUTED', report.summary);
  assert.equal(client.requests.length, 2);
  assert(
    client.requests.every((request) =>
      request.items.some((item) => item.includes('未登录访客')),
    ),
  );
  assert.equal(report.steps[0].environmentHistory.length, 2);
});

// 范围：同一 ID 的不同冻结定义不能复用确认；控制面及人工勾选为夹具，不验证账号资格。
test('步骤复用条件 ID 但改变定义时必须重新确认', async () => {
  const client = new PlannedControl();
  const { report } = await run(
    (context) => finish(context),
    (execution) => {
      planned(execution);
      execution.task.executionPlan.environment.mode = 'configured';
      execution.task.sessionPlan.mode = 'manual';
      execution.task.steps[0].preconditions = [
        { id: 'qualification', method: 'manual', description: '确认资格甲' },
      ];
      execution.task.steps[1].preconditions = [
        { id: 'qualification', method: 'manual', description: '确认资格乙' },
      ];
    },
    client,
    ['a'],
  );
  assert.equal(report.executionDisposition, 'EXECUTED', report.summary);
  assert.equal(client.requests.length, 2);
});

// 范围：无法取证的普通 block 不再自动请求人工，保留原始说明；不评估模型是否正确识别缺口。
test('新计划普通准备阻塞不自动转成人工确认', async () => {
  const client = new PlannedControl();
  const { report } = await run(
    (context) =>
      context.state.phase === 'CHECKING'
        ? {
            type: 'verification.block',
            summary: '当前无法取得所需证据',
            reasonCode: 'OTHER',
          }
        : finish(context),
    (execution) => planned(execution),
    client,
    ['a'],
  );
  assert.equal(report.executionDisposition, 'BLOCKED');
  assert.equal(report.steps[0].reasonCode, 'SETUP_BLOCKED');
  assert.equal(client.requests.length, 0);
});

// 范围：八个并发组共用一次续租和一次最终提交，组结束不撤销兄弟执行；模型、页面和租约回复均为夹具。
test('profile 并发组只使用一个执行租约守卫', { timeout: 10_000 }, async () => {
  const client = new FakeControl();
  const entered = new Set();
  let release;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  const { report } = await run(
    async (context) => {
      if (
        context.state.phase === 'PREPARING' &&
        !entered.has(context.task.stepId)
      ) {
        entered.add(context.task.stepId);
        if (entered.size === 8) setTimeout(release, 350);
        await barrier;
      }
      return finish(context);
    },
    (execution) => {
      execution.leaseExpiresAt = new Date(Date.now() + 600).toISOString();
    },
    client,
    Array.from({ length: 8 }, (_, i) => `lease-${i}`),
  );
  assert.equal(report.verdict, 'PASSED');
  assert.equal(entered.size, 8);
  assert.equal(client.renewals, 1);
  assert.equal(client.reports.length, 1);
});
