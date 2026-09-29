import assert from 'node:assert/strict';
import test from 'node:test';
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
