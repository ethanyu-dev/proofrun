import assert from 'node:assert/strict';
import test from 'node:test';
import { Window } from 'happy-dom';
import { bindHitlPointer } from '../../apps/console/src/pages/hitl-pointer.ts';
import type { NodeCommand } from '../../contracts/src/index.ts';

/** 只模拟本地指针与缩放画面，不连接远端浏览器或验证码服务。 */
function fixture() {
  const window = new Window();
  const prior = new Map(
    ['window', 'document'].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  Object.assign(globalThis, { window, document: window.document });
  const element = window.document.createElement('img');
  element.tabIndex = 0;
  window.document.body.append(element);
  element.getBoundingClientRect = () =>
    ({ left: 10, top: 20, width: 200, height: 100 }) as DOMRect;
  const sent: NodeCommand['command'][] = [];
  const active: boolean[] = [];
  const errors: string[] = [];
  let flushed = 0;
  const dispose = bindHitlPointer(
    element as unknown as HTMLImageElement,
    1000,
    500,
    {
      flush: () => {
        flushed++;
      },
      submit: (command) => {
        sent.push(command);
        return true;
      },
      changed: (value) => active.push(value),
      error: (message) => errors.push(message),
    },
  );
  const pointer = (
    type: string,
    x: number,
    y: number,
    options: Record<string, unknown> = {},
  ) => {
    const event = new window.PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
      pointerId: 1,
      isPrimary: true,
      ...options,
    });
    (type === 'pointerdown' ? element : window).dispatchEvent(event);
    return event;
  };
  return {
    window,
    element,
    sent,
    active,
    errors,
    pointer,
    dispose,
    get flushed() {
      return flushed;
    },
    async close() {
      dispose();
      await window.happyDOM.close();
      for (const [key, descriptor] of prior) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

// 范围：缩放坐标、图片外松手、整段提交和重复 click 抑制；不证明真实浏览器的拖动接收或验证码结果。
test('滑块拖动在松手后提交完整轨迹，图片外松手也能结束', async () => {
  const f = fixture();
  try {
    assert.equal(f.pointer('pointerdown', 30, 40).defaultPrevented, true);
    f.pointer('pointermove', 70, 40);
    assert.equal(f.sent.length, 0);
    f.pointer('pointerup', 230, 150);
    assert.equal(f.flushed, 1);
    assert.deepEqual(f.active, [true, false]);
    assert.equal(f.sent.length, 1);
    const command = f.sent[0]!;
    assert.equal(command.type, 'browser.input');
    if (command.type !== 'browser.input') throw new Error('错误命令');
    assert.equal(command.action, 'drag');
    assert.deepEqual(command.points![0], { x: 100, y: 100, atMs: 0 });
    assert.equal(command.points!.at(-1)!.x, 999);
    assert.equal(command.points!.at(-1)!.y, 499);
    let bubbled = 0;
    f.window.document.addEventListener('click', () => {
      bubbled++;
    });
    const click = new f.window.MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      detail: 1,
    });
    f.element.dispatchEvent(click);
    assert.equal(click.defaultPrevented, true);
    assert.equal(bubbled, 0);
    const nativeDrag = new f.window.DragEvent('dragstart', {
      cancelable: true,
    });
    f.element.dispatchEvent(nativeDrag);
    assert.equal(nativeDrag.defaultPrevented, true);
  } finally {
    await f.close();
  }
});

// 范围：抖动仍是单次点击、非主指针不影响轨迹、返回起点仍是拖动；不模拟操作系统触摸分发。
test('点击兼容且多指不会串改当前拖动', async () => {
  const f = fixture();
  try {
    f.pointer('pointerdown', 30, 40, { button: 2 });
    f.pointer('pointerup', 30, 40, { button: 2 });
    assert.equal(f.sent.length, 0);
    f.pointer('pointerdown', 30, 40);
    f.pointer('pointermove', 100, 40, { pointerId: 2 });
    f.pointer('pointerup', 31, 41);
    assert.deepEqual(f.sent[0], {
      type: 'browser.input',
      action: 'click',
      x: 100,
      y: 100,
    });
    f.pointer('pointerdown', 30, 40);
    f.pointer('pointermove', 100, 40);
    f.pointer('pointerup', 30, 40);
    assert.equal((f.sent[1] as any).action, 'drag');
  } finally {
    await f.close();
  }
});

// 范围：取消、失焦、丢捕获、断线卸载不发送残缺手势；不模拟实际网络中断。
test('中断手势不发送远端按下或延迟点击', async () => {
  for (const kind of [
    'pointercancel',
    'blur',
    'lostpointercapture',
    'buttons',
    'dispose',
  ]) {
    const f = fixture();
    try {
      f.pointer('pointerdown', 30, 40);
      f.pointer('pointermove', 80, 40);
      if (kind === 'dispose') f.dispose();
      else if (kind === 'blur')
        f.window.dispatchEvent(new f.window.Event('blur'));
      else if (kind === 'lostpointercapture')
        f.element.dispatchEvent(
          new f.window.PointerEvent(kind, { pointerId: 1 }),
        );
      else if (kind === 'buttons')
        f.pointer('pointermove', 90, 40, { buttons: 0 });
      else f.pointer(kind, 90, 40);
      f.pointer('pointerup', 100, 40);
      assert.deepEqual(f.sent, []);
      assert.deepEqual(f.active, [true, false]);
    } finally {
      await f.close();
    }
  }
});

// 范围：超长轨迹明确取消且后续松手不提交；不验证真实时钟漂移或服务端命令期限。
test('拖动超过时限会清理本地状态并提示重新操作', async (context) => {
  const f = fixture();
  context.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    f.pointer('pointerdown', 30, 40);
    context.mock.timers.tick(8000);
    f.pointer('pointerup', 100, 40);
    assert.deepEqual(f.sent, []);
    assert.deepEqual(f.active, [true, false]);
    assert.match(f.errors[0]!, /已取消/);
  } finally {
    context.mock.timers.reset();
    await f.close();
  }
});
