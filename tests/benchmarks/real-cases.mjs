import {
  BASIC_INTERACTIONS,
  basicInteractionObjective,
  basicInteractionChecks,
} from '../../contracts/dist/benchmark-interactions.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { benchmarkContext } from '../../contracts/dist/benchmark.js';

/** 真实模型成本按完整十二例预留，不按失败追加重试；各场景的轮次及时间上限保持不变。 */
export const REAL_LIMITS = {
  maxTurns: 12,
  maxContextChars: 12000,
  timeoutMs: 180000,
  maxActions: 10,
};
/** 与脚本套件对应的基础业务场景；故障注入使用真实浏览器操作与真实写入账本。 */
export const realCases = [
  { id: 'form-submit', name: '真实表单填写与单次提交' },
  { id: 'read-only', name: '真实页面只读核验' },
  { id: 'invalid-target', name: '旧观察拒绝与模型恢复' },
  { id: 'unknown-write', name: '真实写入后丢回执保护' },
  { id: 'context-pressure', name: '真实长页面上下文裁剪' },
  { id: 'browser-controls', name: '浏览器任务：选择控件与单次保存' },
  { id: 'browser-tabs', name: '浏览器任务：跨标签读取与返回' },
  { id: 'browser-disclosures', name: '浏览器任务：展开阅读与整理' },
  // 验证真实请求头、缓存分页及精简投影，不覆盖生产站点和远程调度。
  { id: 'network-runtime', name: '网络 context：请求详情与缓存分页' },
  // 验证同快照恢复后真实点击，不用重新观察或页面文字代替网络详情。
  { id: 'network-page-return', name: '网络 context：核验后恢复页面操作' },
  ...BASIC_INTERACTIONS,
];

/** 通用浏览器任务以交付正文完成，不生成空验收项的 PASSED 结论。 */
const BROWSER_OBJECTIVES = {
  'browser-controls':
    '将姓名填写为 Alice，在城市下拉框中选择 Hangzhou，勾选同意保存，保存资料一次。确认保存结果和次数，交付姓名、城市与保存次数，不重复提交。',
  'browser-tabs':
    '读取主页面的主编号，使用详情链接在新标签页打开并读取详情编号，然后切回原主标签页。交付两个编号并说明已经返回主页面，保持两个标签页打开。不提交任何数据。',
  'browser-disclosures':
    '展开并阅读基础方案和专业方案两个折叠面板，整理各自的方案编号与月费，交付对比表。保持两个面板展开，不提交任何数据。',
};

/** 网络场景用真实响应头与缓存元数据验证，不把页面上的提示当作网络证据。 */
const NETWORK_OBJECTIVES = {
  'network-runtime':
    '等待页面显示“准备完成”，核对本页 /resource 请求响应状态为 200，Cache-Control 为 max-age=73。再读取 Cache Storage 中 bench-cache 的全部 24 个条目，核对所有 responseStatus 为 200。不得发送新的探测请求或写入业务数据。',
  'network-page-return':
    '按顺序完成：等待“准备完成”；先读取本页 /resource 请求详情，核对响应状态 200 和 Cache-Control 为 max-age=73；随后点击“显示核验编号”，核对页面出现 RETURN-73。不提交业务数据，不重复请求或刷新页面。',
};

/** 业务目标只是任务定义，模型仍使用项目正式提示词，不提供脚本回复或替代模型决定。 */
export function realGrant(scenario, origin) {
  const readOnly = scenario.id === 'read-only';
  const browser =
    BROWSER_OBJECTIVES[scenario.id] ?? basicInteractionObjective(scenario.id);
  return {
    id: randomUUID(),
    leaseToken: 'local-benchmark-lease',
    nodeId: randomUUID(),
    sessionId: randomUUID(),
    state: 'STARTING',
    leaseExpiresAt: new Date(Date.now() + 30000).toISOString(),
    taskDeadlineAt: new Date(Date.now() + REAL_LIMITS.timeoutMs).toISOString(),
    task: {
      protocolVersion: '0.1',
      taskId: randomUUID(),
      executionMode: 'llm',
      ...(browser ? { taskKind: 'browser' } : {}),
      objective:
        NETWORK_OBJECTIVES[scenario.id] ??
        browser ??
        (readOnly
          ? '只读取当前页面，核对当前状态为已就绪且状态编号为 READY-2026，不执行任何写入。'
          : '将姓名填写为 Alice，城市填写为 Hangzhou，保存资料一次，核对已保存 Alice / Hangzhou 且保存次数为 1。不要重复提交。'),
      environment: {
        id: 'local-benchmark',
        nodePool: 'local-benchmark',
        allowIntervention: false,
      },
      target: { url: `${origin}/${scenario.id}` },
      acceptanceCriteria: browser
        ? []
        : [
            {
              id: 'result',
              description: NETWORK_OBJECTIVES[scenario.id]
                ? '网络与页面事实核验'
                : readOnly
                  ? '状态核验'
                  : '保存结果核验',
              expectedResult:
                NETWORK_OBJECTIVES[scenario.id] ??
                (readOnly
                  ? '当前状态：已就绪，状态编号：READY-2026'
                  : '已保存：Alice / Hangzhou；保存次数 1'),
              evidenceKinds:
                scenario.id === 'network-runtime'
                  ? ['NETWORK', 'RUNTIME']
                  : scenario.id === 'network-page-return'
                    ? ['NETWORK', 'DOM']
                    : ['DOM'],
            },
          ],
      budget: {
        timeoutMs: REAL_LIMITS.timeoutMs,
        maxActions: REAL_LIMITS.maxActions,
      },
    },
  };
}

/** 独立服务端真值与执行器报告交叉核对；故障场景要求故障确实触发，不能静默算作通过。 */
export function verifyRealCase(scenario, control, report, facts) {
  assert(facts.visits > 0, '浏览器必须实际访问本地页面');
  if (basicInteractionObjective(scenario.id)) {
    for (const check of basicInteractionChecks(
      scenario.id,
      report,
      control.commands,
      facts,
    ))
      assert(check.passed, check.name + '：' + check.detail);
    return;
  }
  if (NETWORK_OBJECTIVES[scenario.id]) {
    assert.equal(report.verdict, 'PASSED');
    assert.deepEqual(facts.writes, []);
    const calls = [...control.calls.values()];
    const views = calls.map((call) => benchmarkContext(call)?.context);
    const compact = views.filter((context) => context?.page.view === 'network');
    assert(compact.length > 0, '必须实际进入网络专用 context');
    for (const context of compact) {
      assert.equal(context.page.text, '');
      assert.deepEqual(context.page.targets, []);
      assert.equal(calls[views.indexOf(context)].imagesOmitted, 0);
    }
    assert(
      views.some(
        (context) =>
          context?.page.network?.detail?.captured?.status === 200 &&
          /max-age=73/.test(
            JSON.stringify(context.page.network.detail.captured.headers),
          ),
      ),
      '必须实际读取响应头',
    );
    if (scenario.id === 'network-runtime') {
      const details = views
        .map((context) => context?.page.runtimeDetail)
        .filter((detail) => detail?.path === 'cacheStorage.entries');
      const entries = new Map(
        details.flatMap((detail) =>
          detail.entries.map((entry) => [entry.url, entry]),
        ),
      );
      assert.equal(entries.size, 24, '必须分页交付全部真实缓存条目');
      assert(
        [...entries.values()].every((entry) => entry.responseStatus === 200),
      );
      assert(
        details.some((detail) => detail.offset > 0),
        '必须读取后续页',
      );
    } else {
      const restored = views.findIndex(
        (context, index) =>
          context?.page.view === 'page' &&
          index > 0 &&
          views[index - 1]?.page.view === 'network' &&
          context.page.observationId === views[index - 1].page.observationId,
      );
      assert(restored > 0, '必须不刷新观察而恢复同快照页面');
      assert(
        control.commands.some(
          (command) =>
            command.operation.action === 'click' &&
            command.status === 'SUCCEEDED' &&
            command.decisionIndex >= calls[restored].decisionIndex,
        ),
        '恢复后必须实际点击控件',
      );
      assert(
        control.commands.some(
          (command) =>
            command.operation.type === 'browser.observe' &&
            command.result?.text?.includes('RETURN-73'),
        ),
        '点击后必须有真实页面编号',
      );
    }
    return;
  }
  if (BROWSER_OBJECTIVES[scenario.id]) {
    assert.equal(report.verdict, null, '通用浏览器任务不能伪造业务验收结论');
    assert.equal(report.executionDisposition, 'EXECUTED');
    assert.equal(report.browserResult?.outcome, 'COMPLETED');
    assert(report.browserResult.evidenceRefs.length > 0, '必须交付真实证据');
    const output = report.browserResult.output;
    const commands = control.commands;
    const observations = commands
      .filter(
        (c) =>
          c.operation.type === 'browser.observe' && c.status === 'SUCCEEDED',
      )
      .map((c) => c.result);
    if (scenario.id === 'browser-controls') {
      assert.deepEqual(
        facts.writes,
        [{ name: 'Alice', city: 'Hangzhou', consent: 'on' }],
        '原生选择控件必须产生一次正确写入',
      );
      assert.match(output, /Alice/);
      assert.match(output, /Hangzhou/);
      assert.match(output, /1|一/);
      assert(
        commands.some(
          (c) => c.operation.action === 'select' && c.status === 'SUCCEEDED',
        ),
        '必须实际使用选择控件',
      );
    } else {
      assert.deepEqual(facts.writes, []);
      const tokens =
        scenario.id === 'browser-tabs'
          ? ['MAIN-42', 'DETAIL-73']
          : ['BASIC-17', 'PRO-29', '19', '49'];
      for (const token of tokens) {
        assert(output.includes(token), `交付正文缺少 ${token}`);
        assert(
          observations.some((page) => page?.text?.includes(token)),
          `缺少实际读取 ${token} 的观察`,
        );
      }
      if (scenario.id === 'browser-tabs') {
        assert(
          commands.some(
            (c) =>
              c.operation.action === 'tab.switch' && c.status === 'SUCCEEDED',
          ),
          '必须真实切换标签',
        );
        const last = observations.at(-1);
        assert(last?.tabs?.length >= 2, '结束时必须保留两个真实标签');
        assert(!new URL(last.url).hash, '结束时必须回到主页面');
      } else {
        assert(
          commands.filter(
            (c) => c.operation.action === 'click' && c.status === 'SUCCEEDED',
          ).length >= 2,
          '必须真实展开两项内容',
        );
        assert(
          observations.at(-1)?.text?.includes('BASIC-17') &&
            observations.at(-1)?.text?.includes('PRO-29'),
          '结束时两个折叠项必须都保持展开',
        );
        for (const token of ['BASIC-17', 'PRO-29'])
          assert(
            observations
              .at(-1)
              ?.targets?.some(
                (target) =>
                  target.disclosure?.expanded &&
                  target.disclosure.visible &&
                  target.disclosure.text.includes(token),
              ),
            `面板 ${token} 必须有真实展开和可见回执，正文包含文字不能替代展开证明`,
          );
      }
    }
    return;
  }
  if (scenario.id === 'read-only') {
    assert.equal(report.verdict, 'PASSED');
    assert.deepEqual(facts.writes, []);
    assert(
      !control.commands.some(
        (command) =>
          command.operation.type === 'browser.act' &&
          command.operation.action !== 'navigate',
      ),
      '只读任务不得执行写动作',
    );
  } else {
    assert.deepEqual(
      facts.writes,
      [{ name: 'Alice', city: 'Hangzhou' }],
      '服务端必须恰好收到一次正确写入',
    );
    if (scenario.id === 'unknown-write') {
      assert.equal(control.injected, true);
      assert.notEqual(report.verdict, 'PASSED');
    } else assert.equal(report.verdict, 'PASSED');
  }
  if (scenario.id === 'invalid-target') {
    assert(
      control.injected && control.staleRejected,
      '生产宿主必须实际拒绝旧观察',
    );
    assert(
      [...control.calls.values()].some(
        (call) => benchmarkContext(call)?.context.feedback?.length,
      ),
      '新轮次必须收到错误反馈',
    );
  }
  if (scenario.id === 'context-pressure')
    assert(
      [...control.calls.values()].some(
        (call) =>
          benchmarkContext(call)?.context.page?.coverage?.text?.truncated,
      ),
      '必须实际触发上下文裁剪',
    );
}
