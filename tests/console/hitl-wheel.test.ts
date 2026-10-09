import assert from 'node:assert/strict';
import test from 'node:test';
import { captureRemoteWheel } from '../../apps/console/src/pages/hitl-wheel.ts';

// 范围：原生事件取消、单次转发和解除监听；不模拟真实触控板惯性或远端滚动距离。
test('聚焦滚轮阻止本地默认动作，释放后恢复默认行为', () => {
  const screen = new EventTarget();
  let forwarded = 0;
  const release = captureRemoteWheel(screen, (event) => {
    assert.equal(event.defaultPrevented, true);
    forwarded++;
  });
  assert.equal(
    screen.dispatchEvent(new Event('wheel', { cancelable: true })),
    false,
  );
  assert.equal(forwarded, 1);
  release();
  assert.equal(
    screen.dispatchEvent(new Event('wheel', { cancelable: true })),
    true,
  );
  assert.equal(forwarded, 1);
  const releaseAgain = captureRemoteWheel(screen, () => forwarded++);
  screen.dispatchEvent(new Event('wheel', { cancelable: true }));
  assert.equal(forwarded, 2);
  releaseAgain();
});
