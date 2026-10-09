import assert from 'node:assert/strict';
import test from 'node:test';
import { waitForEvidence } from '../../apps/agent/dist/evidence/delivery.js';
import { AgentFault, pause } from '../../apps/agent/dist/http.js';

/** 仅模拟控制面证据状态，不生成真实截图或连接节点。 */
const refs = [
  { artifactId: 'fixture-dom', kind: 'DOM', sha256: 'a'.repeat(64) },
  { artifactId: 'fixture-png', kind: 'SCREENSHOT', sha256: 'b'.repeat(64) },
];
/** 按引用构造独立视图，状态变化由每个 case 显式控制。 */
function view(states) {
  return {
    taskState: 'RUNNING',
    artifacts: refs.map((ref, i) => ({
      id: ref.artifactId,
      kind: ref.kind,
      sha256: ref.sha256,
      state: states[i],
    })),
  };
}

// 范围：上传后仍等待可用回执；只模拟状态流转，不证明真实上传吞吐。
test('证据必须从 PENDING 经 STORED 到 AVAILABLE 才能交给模型', async () => {
  let reads = 0;
  await waitForEvidence(
    refs,
    async () =>
      view(['AVAILABLE', ['PENDING', 'STORED', 'AVAILABLE'][reads++]]),
    2000,
    new AbortController().signal,
  );
  assert.equal(reads, 3);
});

// 范围：缺失、类型/摘要不符和未确认均不能冒充可用；不覆盖真实数据库损坏。
test('超时列出未就绪证据身份和阶段，不泄露页面或未知状态', async () => {
  const expected = [
    ...refs,
    { artifactId: 'fixture-trace', kind: 'TRACE', sha256: 'c'.repeat(64) },
  ];
  const current = view(['AVAILABLE', 'STORED']);
  current.artifacts[0].sha256 = 'd'.repeat(64);
  await assert.rejects(
    waitForEvidence(
      expected,
      async () => current,
      30,
      new AbortController().signal,
    ),
    (error) => {
      assert.equal(error.code, 'EVIDENCE_UNAVAILABLE');
      assert.match(error.message, /DOM fixture-dom=MISMATCH/);
      assert.match(error.message, /SCREENSHOT fixture-png=STORED/);
      assert.match(error.message, /TRACE fixture-trace=MISSING/);
      return true;
    },
  );
  const unsafe = view(['AVAILABLE', 'secret-provider-body']);
  await assert.rejects(
    waitForEvidence(refs, async () => unsafe, 30, new AbortController().signal),
    (error) => {
      assert.match(error.message, /fixture-png=UNKNOWN/);
      assert.ok(!error.message.includes('secret-provider-body'));
      return true;
    },
  );
});

// 范围：证据预算可取消在途读取；不模拟 HTTP 服务自身的取消实现。
test('证据超时中断挂起的控制面读取', async () => {
  let signal;
  await assert.rejects(
    waitForEvidence(
      refs,
      async (current) => {
        signal = current;
        await pause(10_000, current);
        throw new Error('读取不应继续');
      },
      30,
      new AbortController().signal,
    ),
    { code: 'EVIDENCE_UNAVAILABLE' },
  );
  assert.equal(signal.aborted, true);
});

// 范围：外部取消、任务截止和租约失效优先；用显式撤权夹具，不证明真实租约网络行为。
test('等待证据时保留外部撤权原因', async () => {
  for (const code of ['TASK_DEADLINE', 'LEASE_LOST', 'EXECUTION_CLOSED']) {
    const stop = new AbortController();
    const reason = new AgentFault(code, '夹具撤权');
    await assert.rejects(
      waitForEvidence(
        refs,
        async () => {
          stop.abort(reason);
          return view(['AVAILABLE', 'AVAILABLE']);
        },
        1000,
        stop.signal,
      ),
      (error) => error === reason,
    );
  }
});

// 范围：TRACE 和截图共用的状态检查不得继续已结束任务；不触发真实取消操作。
test('控制面终态不能因证据已到达而继续', async () => {
  await assert.rejects(
    waitForEvidence(
      refs,
      async () => ({
        ...view(['AVAILABLE', 'AVAILABLE']),
        taskState: 'CANCELLED',
      }),
      1000,
      new AbortController().signal,
    ),
    { code: 'EXECUTION_ENDED' },
  );
});
