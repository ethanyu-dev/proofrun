import assert from 'node:assert/strict';
import test from 'node:test';
import { remainingTime } from '../../apps/console/src/pages/hitl-navigation.tsx';
import type { NodeCommand } from '../../contracts/src/index.ts';
import {
  HitlInputQueue,
  INPUT_ACK_MS,
} from '../../apps/console/src/pages/hitl-input.ts';

/** 队列夹具记录发送和停止通知，不连接真实浏览器。 */
function fixture() {
  const sent: { commandId: string; command: NodeCommand['command'] }[] = [];
  let busy = false;
  let stopped = 0;
  const queue = new HitlInputQueue(
    (item) => {
      sent.push(item);
      return true;
    },
    (value) => {
      busy = value;
    },
    () => {
      stopped++;
    },
  );
  return {
    queue,
    sent,
    get busy() {
      return busy;
    },
    get stopped() {
      return stopped;
    },
    ack(index: number, status = 'SUCCEEDED') {
      return queue.acknowledge({
        type: 'result',
        commandId: sent[index]!.commandId,
        status,
        effect: 'APPLIED',
      });
    },
  };
}
/** 点击位置只用于检查动作顺序，不代表真实页面命中。 */
const click = (x = 20): NodeCommand['command'] => ({
  type: 'browser.input',
  action: 'click',
  x,
  y: 20,
});

// 范围：组合操作按成功回执执行，失败或断线不刷新；不验证真实 Cookie 登录。
test('Cookie 与刷新整体入队并等待写入成功', () => {
  for (const status of ['SUCCEEDED', 'FAILED', 'UNKNOWN', 'disconnect']) {
    const f = fixture();
    try {
      assert.equal(
        f.queue.enqueueBatch([
          {
            type: 'browser.cookies.set',
            url: 'https://example.com',
            name: 'token',
            value: 'fixture',
          },
          { type: 'browser.act', action: 'reload' },
        ]),
        true,
      );
      assert.equal(f.sent.length, 1);
      if (status === 'disconnect') f.queue.reset();
      else f.ack(0, status);
      assert.equal(f.sent.length, status === 'SUCCEEDED' ? 2 : 1);
      if (status === 'SUCCEEDED')
        assert.equal(f.sent[1]!.command.type, 'browser.act');
    } finally {
      f.queue.reset();
    }
  }
});

// 范围：容量不足时不部分接收组合操作；不覆盖服务端预算。
test('组合操作容量不足时全部拒绝', () => {
  const f = fixture();
  try {
    for (let i = 0; i < 8; i++) f.queue.enqueue(click(i));
    assert.equal(f.queue.enqueueBatch([click(20), click(21)]), false);
    for (let i = 0; i < 8; i++) f.ack(i);
    assert.equal(f.sent.length, 8);
  } finally {
    f.queue.reset();
  }
});

// 范围：到期显示不出现负值；不验证服务端时钟同步。
test('授权剩余时间在截止后显示已到期', () => {
  const end = '2026-10-09T12:00:00Z';
  assert.equal(remainingTime(end, Date.parse(end) - 61000), '1:01');
  assert.equal(remainingTime(end, Date.parse(end)), '已到期');
  assert.equal(remainingTime(end, Date.parse(end) + 1000), '已到期');
});

// 范围：密集触控板滚动不会耗尽队列，点击保持顺序；不验证真实浏览器滚动距离。
test('连续滚动合并后仍能接受授权按钮点击', () => {
  const f = fixture();
  try {
    f.queue.enqueue(click());
    for (let i = 0; i < 80; i++)
      assert.equal(
        f.queue.enqueue({
          type: 'browser.input',
          action: 'scroll',
          x: 30,
          y: 40,
          deltaX: 0,
          deltaY: 40,
        }),
        true,
      );
    assert.equal(f.queue.enqueue(click(100)), true);
    assert.equal(f.sent.length, 1);
    f.ack(0);
    assert.deepEqual(f.sent[1]!.command, {
      type: 'browser.input',
      action: 'scroll',
      x: 30,
      y: 40,
      deltaX: 0,
      deltaY: 2000,
    });
    f.ack(0); // 重复回执不能发送下一个点击。
    assert.equal(f.sent.length, 2);
    f.ack(1);
    assert.deepEqual(f.sent[2]!.command, click(100));
    f.ack(2);
    assert.equal(f.busy, false);
  } finally {
    f.queue.reset();
  }
});

// 范围：本地队列满后可随回执恢复，接受过的点击不会丢失；不模拟服务器动作预算。
test('队列满是暂时背压，回执释放后继续操作', () => {
  const f = fixture();
  try {
    for (let i = 0; i < 9; i++) assert.equal(f.queue.enqueue(click(i)), true);
    assert.equal(f.queue.enqueue(click(99)), false);
    f.ack(0);
    assert.equal(f.queue.enqueue(click(10)), true);
    for (let i = 1; i < 10; i++) f.ack(i);
    assert.equal(f.sent.length, 10);
    assert.equal(f.busy, false);
    assert.equal(f.stopped, 0);
  } finally {
    f.queue.reset();
  }
});

// 范围：连接仍打开但回执丢失时有界停止，重连不重放；不代表实际网络超时验收。
test('回执超时清空旧队列并忽略迟到结果', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.queue.enqueue(click());
  f.queue.enqueue(click(100));
  t.mock.timers.tick(INPUT_ACK_MS);
  assert.equal(f.busy, false);
  assert.equal(f.stopped, 1);
  assert.equal(f.ack(0), false);
  assert.equal(f.sent.length, 1);
  assert.equal(f.queue.enqueue(click()), false);
  f.queue.reset();
  f.queue.enqueue(click(200));
  assert.equal(f.sent.length, 2);
  assert.deepEqual(f.sent[1]!.command, click(200));
  f.queue.reset();
});

// 范围：失败回执和发送前断线均停止后续输入；不覆盖节点实际失败原因。
test('未知结果或不可用连接不能继续派发', () => {
  const f = fixture();
  f.queue.enqueue(click());
  f.queue.enqueue(click(100));
  f.ack(0, 'UNKNOWN');
  assert.equal(f.sent.length, 1);
  assert.equal(f.stopped, 1);
  assert.equal(f.busy, false);
  let stopped = 0;
  const unavailable = new HitlInputQueue(
    () => false,
    () => {},
    () => {
      stopped++;
    },
  );
  unavailable.enqueue(click());
  assert.equal(stopped, 1);
  assert.equal(unavailable.busy, false);
  f.queue.reset();
  unavailable.reset();
});

// 范围：Cookie 写入按原队列串行等待回执，失败停止且不重放；不连接真实浏览器或验证 Cookie 登录。
test('Cookie 写入等待确认且失败后不派发后续输入', () => {
  const f = fixture();
  try {
    f.queue.enqueue({
      type: 'browser.cookies.set',
      url: 'https://example.com/',
      name: 'token',
      value: 'fixture-only',
      httpOnly: true,
    });
    f.queue.enqueue(click());
    assert.equal(f.sent.length, 1);
    f.ack(0, 'UNKNOWN');
    assert.equal(f.sent.length, 1);
    assert.equal(f.stopped, 1);
  } finally {
    f.queue.reset();
  }
});

// 范围：整组回执、失败、断线、超时只通知一次，不把部分写入当成完成；不验证站点登录。
test('批量 Cookie 的完成提示必须等待最后一次刷新回执', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const outcome of ['success', 'failed', 'disconnect', 'timeout']) {
    const f = fixture();
    const results: string[] = [];
    f.queue.enqueueBatch(
      [click(1), click(2), { type: 'browser.act', action: 'reload' }],
      (result) => results.push(result),
    );
    f.ack(0);
    assert.deepEqual(results, []);
    f.ack(1);
    assert.deepEqual(results, []);
    if (outcome === 'success') f.ack(2);
    else if (outcome === 'failed') f.ack(2, 'FAILED');
    else if (outcome === 'disconnect') f.queue.reset();
    else t.mock.timers.tick(INPUT_ACK_MS);
    f.ack(2);
    f.queue.reset();
    assert.deepEqual(results, [
      outcome === 'success' ? 'succeeded' : 'unconfirmed',
    ]);
  }
});

// 范围：前一项失败时通知尚未派发的组合操作，空批次不产生成功提示；不模拟真实断网。
test('批次尚未派发也能收到终止通知', () => {
  const f = fixture();
  const results: string[] = [];
  assert.equal(
    f.queue.enqueueBatch([], (r) => results.push(r)),
    false,
  );
  f.queue.enqueue(click());
  f.queue.enqueueBatch([click(2)], (r) => results.push(r));
  f.ack(0, 'UNKNOWN');
  f.queue.reset();
  assert.deepEqual(results, ['unconfirmed']);
  assert.equal(f.sent.length, 1);
});
