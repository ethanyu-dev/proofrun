import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { JevModel } from '../../apps/agent/dist/model/jev.js';
import { ChatModel } from '../../apps/agent/dist/model/chat.js';
import { prepareJevImage } from '../../apps/agent/dist/model/jev-image.js';
import { jevBoxPoint } from '../../apps/agent/dist/model/jev-box.js';
import { AgentFault } from '../../apps/agent/dist/http.js';
import { config, modelServer } from './fixture.mjs';
const sharp = createRequire(
  new URL('../../apps/agent/package.json', import.meta.url),
)('sharp');

/** 合成像素用于验证传输和缩放，不是任何站点的业务证据。 */
async function picture(width = 1280, height = 720, noise = false) {
  return noise
    ? sharp(randomBytes(width * height * 3), {
        raw: { width, height, channels: 3 },
      })
        .png()
        .toBuffer()
    : sharp({ create: { width, height, channels: 3, background: '#568abc' } })
        .png()
        .toBuffer();
}
/** 图片摘要绑定本轮观察；页面和模型回复全部为夹具。 */
function input(
  bytes,
  targets = [
    { target: 'continue', name: '继续', role: 'button', operations: ['click'] },
  ],
) {
  const observation = {
    observationId: 'vision-observation',
    url: 'https://fixture.test/vision',
    title: '视觉夹具',
    text: '选择继续',
    atomic: false,
    targets,
    viewport: { width: 1280, height: 720, x: 0, y: 0, visualRecheck: 'sha256' },
    artifactRefs: bytes
      ? [
          {
            artifactId: 'screen',
            kind: 'SCREENSHOT',
            sha256: createHash('sha256').update(bytes).digest('hex'),
          },
        ]
      : [],
  };
  return {
    text: JSON.stringify({
      task: { taskId: 'vision-fixture', objective: '选择继续' },
      observation,
      recentOperations: [],
      feedback: null,
      budgetRemaining: { actions: 10 },
    }),
    observation,
    ...(bytes
      ? { image: `data:image/png;base64,${bytes.toString('base64')}` }
      : {}),
  };
}
/** 概率只驱动代码分支，不代表供应商预测质量。 */
function choice(criteria, id) {
  assert(id in criteria);
  return {
    choice: id,
    confidence: 1,
    probabilities: Object.fromEntries(
      Object.keys(criteria).map((key) => [key, Number(key === id)]),
    ),
  };
}
/** 请求注入只替换模型端口；图片、分组和计量运行真实实现。 */
function harness(
  options = {},
  answer = (body) => ({
    answers: { next: choice(body.questions.next.criteria, 'A1') },
    usage: { input_tokens: 11, output_tokens: 2 },
  }),
) {
  const calls = [],
    reviews = [];
  const model = new JevModel(
    { ...config, maxContextChars: 256_000, jevImages: true, ...options },
    'fixture',
    undefined,
    async (...args) => {
      calls.push({ body: args[3], headers: args[6] });
      return answer(args[3], calls.length);
    },
    {
      decide: async (request) => {
        reviews.push(request);
        return {
          decision: { type: 'browser.observe' },
          promptTokens: 3,
          completionTokens: 1,
        };
      },
    },
  );
  return { model, calls, reviews };
}
const signal = () => new AbortController().signal;
/** Box 回复表示明确的单一目标，非真实定位结果。 */
function located() {
  return {
    exists: { noul: 0.99 },
    unique: choice({ none: '', one: '', several: '' }, 'one'),
    target: {
      confidence: 0.99,
      box: { left: 0.1, right: 0.3, top: 0.2, bottom: 0.4 },
    },
  };
}

// 范围：实际 PNG 预处理、图片协议和审计摘要；不调用 TypeSafe，不证明图像理解质量。
test('JEV 图片只引用一次，base64 不进入调用存档或文本 token 预算', async () => {
  const request = input(await picture(320, 320, true));
  const { model, calls } = harness();
  const traces = [],
    counted = [];
  request.traceRequest = async (record) => {
    traces.push(record);
    return async () => {};
  };
  request.recordRequest = (name) => counted.push(name);
  const output = await model.decide(request, signal());
  assert.equal(output.decision.action, 'click');
  assert.equal(counted.length, 1);
  const { body, headers } = calls[0];
  assert.equal(headers['TypeSafe-Danger-Zone-Images'], 'true');
  const reference = body.state.screenshot;
  assert.deepEqual(Object.keys(body.assets), [reference]);
  assert.equal(body.assets[reference].format, 'png');
  assert(!body.assets[reference].data_base64.startsWith('data:'));
  assert(body.assets[reference].data_base64.length > 64_000);
  assert.equal(JSON.stringify(body.state).split(reference).length - 1, 1);
  assert.equal(traces[0].imagesOmitted, 1);
  assert(!traces[0].request.includes(body.assets[reference].data_base64));
  assert.equal(
    traces[0].requestSha256,
    createHash('sha256').update(JSON.stringify(body)).digest('hex'),
  );
  assert.equal(
    JSON.parse(traces[0].request).state.screenshotSource.artifactId,
    'screen',
  );
});

// 范围：大图等比缩小、小图右下补白与原始来源保留；不保证真实小字识别效果。
test('图片缩放和补白保留可逆尺寸及证据摘要', async () => {
  for (const [width, height, expected] of [
    [3200, 1800, [1568, 882]],
    [100, 20, [280, 280]],
  ]) {
    const request = input(await picture(width, height));
    const prepared = await prepareJevImage(request.image, request.observation);
    const metadata = await sharp(
      Buffer.from(prepared.asset.data_base64, 'base64'),
    ).metadata();
    assert.deepEqual([metadata.width, metadata.height], expected);
    assert.equal(prepared.metadata.originalWidth, width);
    assert.equal(
      prepared.metadata.sourceSha256,
      request.observation.artifactRefs[0].sha256,
    );
    assert.notEqual(prepared.metadata.sha256, prepared.metadata.sourceSha256);
  }
});

// 范围：跨观察或错误摘要不能作为本轮图片发送；不覆盖控制面的存储归属校验。
test('图片与观察不匹配时停止派发', async () => {
  const request = input(await picture());
  request.observation.artifactRefs[0].sha256 = 'b'.repeat(64);
  const { model, calls, reviews } = harness();
  await assert.rejects(model.decide(request, signal()), {
    code: 'EVIDENCE_MISMATCH',
  });
  assert.equal(calls.length, 0);
  assert.equal(reviews.length, 0);
});

// 范围：关闭开关和 fork 的能力继承；不验证真实多 tab 截图捕获。
test('JEV 图片开关独立且 fork 继承', async () => {
  const request = input(await picture());
  const off = harness({ jevImages: false });
  await off.model.decide(request, signal());
  assert.equal(off.calls[0].body.assets, undefined);
  assert.equal(off.calls[0].headers, undefined);
  const on = harness();
  await on.model.fork().decide(request, signal());
  assert(on.calls[0].body.assets);
});

// 范围：图片参数拒绝只回退一次，后续采用文本；认证失败不伪装成图片问题。
test('图片拒绝有界降级，认证错误保持失败', async () => {
  const request = input(await picture());
  const h = harness({}, (body, n) => {
    if (n === 1) throw new AgentFault('HTTP_ERROR', 'fixture', 413);
    return { answers: { next: choice(body.questions.next.criteria, 'A1') } };
  });
  await h.model.decide(request, signal());
  await h.model.decide(request, signal());
  assert.equal(h.reviews.length, 1);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].body.assets, undefined);
  assert.match(h.calls[1].body.state.imageUnavailable, /供应商拒绝/);
  const denied = harness({}, () => {
    throw new AgentFault('HTTP_ERROR', 'fixture', 401);
  });
  await assert.rejects(denied.model.decide(request, signal()), { status: 401 });
  assert.equal(denied.reviews.length, 0);
});

// 范围：本地 HTTP 实际消息和工具过滤；不验证真实文本供应商支持情况。
test('JEV 开启图片不会把图片或视觉点击权限传给纯文本 LLM', async () => {
  const server = await modelServer(() => ({ type: 'browser.observe' }));
  try {
    const request = input(await picture());
    await new ChatModel({
      ...config,
      modelUrl: server.url,
      jevImages: true,
    }).decide(request, signal());
    const body = server.requests[0];
    assert.equal(typeof body.messages[1].content, 'string');
    const tool = body.tools.find((t) => t.function.name === 'browser_act');
    assert(
      !tool.function.parameters.properties.action.enum.includes('visual.click'),
    );
  } finally {
    await server.close();
  }
});

// 范围：从未裁剪原始观察恢复候选，跨分组选择第 300 项；概率为夹具，不证明候选排序质量。
test('扩展分组突破本地 200 动作限制且每个 Choice 不超过 255', async () => {
  const targets = Array.from({ length: 300 }, (_, i) => ({
    target: `t${i + 1}`,
    name: `继续 ${i + 1}`,
    role: 'button',
    operations: ['click'],
  }));
  const request = input(undefined, targets);
  const context = JSON.parse(request.text);
  context.observation.targets = targets.slice(0, 20);
  request.text = JSON.stringify(context);
  const h = harness(
    { jevImages: false, jevLongContext: true, jevExpandedActions: true },
    (body) => {
      const group = Object.keys(body.questions).find(
        (k) => body.questions[k].criteria.A300,
      );
      assert(group);
      for (const q of Object.values(body.questions))
        assert(Object.keys(q.criteria).length <= 255);
      return {
        answers: {
          next: choice(body.questions.next.criteria, group),
          [group]: choice(body.questions[group].criteria, 'A300'),
        },
      };
    },
  );
  const output = await h.model.decide(request, signal());
  assert.equal(output.decision.target, 't300');
  assert.equal(h.calls[0].body.state.candidateCoverage.returnedActions, 300);
  assert.equal(h.calls[0].body.state.candidateCoverage.textViewTargets, 20);
});

// 范围：节点明确能力生成勾选、取消、横向滚动、frame 和 hover；不证明实际控件交互效果。
test('扩展动作绑定能力和当前状态', async () => {
  for (const [operation, target, action, value] of [
    [
      'CHECK',
      {
        role: 'checkbox',
        checked: false,
        operations: ['click', 'check', 'uncheck'],
      },
      'check',
    ],
    [
      'UNCHECK',
      {
        role: 'checkbox',
        checked: true,
        operations: ['click', 'check', 'uncheck'],
      },
      'uncheck',
    ],
    ['FRAME', { role: 'iframe', operations: ['frame'] }, 'frame'],
    ['HOVER', { role: 'button', operations: ['click', 'hover'] }, 'hover'],
    [
      'SCROLL_RIGHT',
      {
        role: 'element',
        operations: ['scroll'],
        scroll: {
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          scrollWidth: 300,
          scrollHeight: 100,
        },
      },
      'scroll',
      'right',
    ],
  ]) {
    const request = input(undefined, [
      { name: '继续', target: 't', ...target },
    ]);
    const h = harness(
      { jevImages: false, jevExpandedActions: true },
      (body) => {
        const group = Object.keys(body.questions.next.criteria).find(
          (k) => body.questions.next.criteria[k].operation === operation,
        );
        const id = Object.keys(body.questions[group].criteria).find(
          (k) => k !== 'NONE',
        );
        return {
          answers: {
            next: choice(body.questions.next.criteria, group),
            [group]: choice(body.questions[group].criteria, id),
          },
        };
      },
    );
    assert.deepEqual((await h.model.decide(request, signal())).decision, {
      type: 'browser.act',
      action,
      target: 't',
      ...(value ? { value } : {}),
    });
  }
});

// 范围：第二次模型调用的计量和 CSS 坐标映射；不执行浏览器输入，不验证模型找框能力。
test('Box 存在且唯一时映射坐标并计入全部调用', async () => {
  const request = input(await picture());
  let count = 0;
  request.recordRequest = () => count++;
  const h = harness({ jevBox: true }, (body) =>
    body.questions.target
      ? { answers: located(), usage: { input_tokens: 7, output_tokens: 2 } }
      : {
          answers: {
            next: choice(body.questions.next.criteria, 'VISUAL_LOCATE'),
          },
          usage: { input_tokens: 5, output_tokens: 1 },
        },
  );
  const output = await h.model.decide(request, signal());
  assert.equal(output.decision.action, 'visual.click');
  assert.equal(output.decision.x, 256);
  assert(Math.abs(output.decision.y - 216) < 1e-9);
  assert.equal(output.promptTokens, 12);
  assert.equal(output.completionTokens, 3);
  assert.equal(count, 2);
});

// 范围：缺失、多义、低置信度、越界和补白区不能产生坐标；不代表这些门槛已获真实质量校准。
test('Box 无效结果拒绝执行', async () => {
  const request = input(await picture());
  const image = await prepareJevImage(request.image, request.observation);
  for (const change of [
    (a) => {
      a.exists.noul = 0.1;
    },
    (a) => {
      a.unique = choice({ none: '', one: '', several: '' }, 'several');
    },
    (a) => {
      a.target.confidence = 0.5;
    },
    (a) => {
      a.target.box.left = -0.1;
    },
    (a) => {
      a.target.box.left = 0.8;
    },
  ]) {
    const answers = located();
    change(answers);
    assert.throws(() => jevBoxPoint(answers, image, request.observation), {
      code: 'INVALID_MODEL_DECISION',
    });
  }
  const small = input(await picture(100, 20));
  small.observation.viewport = {
    width: 100,
    height: 20,
    visualRecheck: 'sha256',
  };
  const padded = await prepareJevImage(small.image, small.observation);
  assert.throws(() => jevBoxPoint(located(), padded, small.observation), {
    code: 'INVALID_MODEL_DECISION',
  });
});

// 范围：旧节点缺少画面复核能力时不暴露 Box，第二请求预算失败不得派发；不连接真实模型。
test('Box 遵守节点能力和模型请求预算', async () => {
  const request = input(await picture());
  delete request.observation.viewport.visualRecheck;
  const old = harness({ jevBox: true });
  await old.model.decide(request, signal());
  assert(!('VISUAL_LOCATE' in old.calls[0].body.questions.next.criteria));
  const fresh = input(await picture());
  let count = 0;
  fresh.recordRequest = () => {
    if (++count > 1)
      throw new AgentFault('STEP_MODEL_BUDGET_EXCEEDED', 'fixture');
  };
  const h = harness({ jevBox: true }, (body) => ({
    answers: { next: choice(body.questions.next.criteria, 'VISUAL_LOCATE') },
  }));
  await assert.rejects(h.model.decide(fresh, signal()), {
    code: 'STEP_MODEL_BUDGET_EXCEEDED',
  });
  assert.equal(h.calls.length, 1);
});

// 范围：执行循环按策略采图、下载并绑定当前观察；控制面和业务结论为夹具，非真实浏览器验收。
test('JEV 独立视觉开关贯通观察到模型，纯 LLM 任务不受影响', async () => {
  const { execute } = await import('../../apps/agent/dist/execution/runner.js');
  const { grant, FakeControl, finish } = await import('./fixture.mjs');
  const bytes = await picture();
  for (const mode of ['jev', 'llm']) {
    const execution = grant();
    execution.task.executionMode = mode;
    const client = new FakeControl();
    const command = client.command.bind(client);
    client.command = async (...args) => {
      const result = await command(...args);
      if (args[2].type === 'browser.observe' && args[2].screenshot) {
        const artifact = {
          id: `screen-${client.calls.length}`,
          kind: 'SCREENSHOT',
          state: 'AVAILABLE',
          sha256: createHash('sha256').update(bytes).digest('hex'),
        };
        client.artifacts.push(artifact);
        result.data.artifactRefs.push({
          artifactId: artifact.id,
          kind: artifact.kind,
          sha256: artifact.sha256,
        });
      }
      return result;
    };
    let downloads = 0;
    client.image = async () => {
      downloads++;
      return `data:image/png;base64,${bytes.toString('base64')}`;
    };
    let received;
    await execute(
      { ...config, jevImages: true },
      client,
      {
        decide: async (request) => {
          received = request;
          return {
            decision: finish(JSON.parse(request.text)),
            promptTokens: 0,
            completionTokens: 0,
          };
        },
      },
      execution,
    );
    assert(received);
    assert.equal(!!received.image, mode === 'jev');
    assert.equal(downloads > 0, mode === 'jev');
    assert.equal(
      received.observation.observationId,
      JSON.parse(received.text).observation.observationId,
    );
  }
});

// 范围：视觉定位命中已知 DOM 后恢复身份校验，并拒绝绕过阅读进度；模型为夹具。
test('Box 命中已有目标时使用 DOM 点击，已读目标交回审查', async () => {
  for (const recorded of [false, true]) {
    const request = input(await picture(), [
      {
        target: 'known',
        name: '继续',
        role: 'button',
        operations: ['click'],
        clip: { left: 200, top: 180, right: 300, bottom: 250 },
      },
    ]);
    if (recorded) {
      const context = JSON.parse(request.text);
      context.interactionProgress = {
        items: [],
        currentTargets: [
          { target: 'known', status: 'recorded', itemId: 'read' },
        ],
      };
      request.text = JSON.stringify(context);
    }
    const h = harness({ jevBox: true }, (body) =>
      body.questions.target
        ? { answers: located() }
        : {
            answers: {
              next: choice(body.questions.next.criteria, 'VISUAL_LOCATE'),
            },
          },
    );
    const output = await h.model.decide(request, signal());
    assert.equal(output.decision.action, recorded ? undefined : 'click');
    assert.equal(h.reviews.length, Number(recorded));
    if (!recorded) assert.equal(output.decision.target, 'known');
  }
});
