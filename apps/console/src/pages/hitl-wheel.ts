/** 聚焦画面时独占滚轮；React 的被动 wheel 监听无法阻止宿主页面默认滚动。 */
export function captureRemoteWheel(
  screen: EventTarget,
  forward: (event: WheelEvent) => void,
): () => void {
  const wheel = (event: Event) => {
    // 即使远端队列已满，也不能让同一次手势落到本地页面。
    event.preventDefault();
    event.stopPropagation();
    forward(event as WheelEvent);
  };
  screen.addEventListener('wheel', wheel, { passive: false });
  return () => screen.removeEventListener('wheel', wheel);
}
