import { useEffect, useRef, type RefObject } from 'react';
import type { NodeCommand } from '@proofrun/contracts';

/** 与协议滚动上限一致；行模式滚轮按常见行高换算为 CSS 像素。 */
const SCROLL_LIMIT = 2000;
const LINE_HEIGHT = 16;

/** 保持缩放后坐标在真实视口内，避免图片边缘舍入越界。 */
export function screenPoint(
  clientX: number,
  clientY: number,
  rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
  width: number,
  height: number,
) {
  return {
    x: Math.max(
      0,
      Math.min(width - 1, ((clientX - rect.left) * width) / rect.width),
    ),
    y: Math.max(
      0,
      Math.min(height - 1, ((clientY - rect.top) * height) / rect.height),
    ),
  };
}

/** 只在画面持有焦点时锁住宿主页面；不影响下面表单的正常滚动。 */
export function useHitlScreen({
  screen,
  interactive,
  width,
  height,
  flush,
  submit,
  release,
}: {
  screen: RefObject<HTMLImageElement | null>;
  interactive: boolean;
  width: number;
  height: number;
  flush: () => void;
  submit: (command: NodeCommand['command']) => boolean;
  release: () => void;
}) {
  // 回调读取当前连接与队列，避免每一帧重新绑定全局监听器。
  const handlers = useRef({ flush, submit, release });
  handlers.current = { flush, submit, release };
  useEffect(() => {
    const element = screen.current;
    if (!interactive || !element) {
      element?.blur();
      handlers.current.release();
      return;
    }
    const leave = () => {
      element.blur();
      handlers.current.release();
    };
    const outside = (event: PointerEvent) => {
      if (event.target !== element) leave();
    };
    const wheel = (event: WheelEvent) => {
      if (document.activeElement !== element) return;
      // React 的 wheel 监听可能为 passive，必须原生注册才能阻止宿主页面滚动。
      event.preventDefault();
      if (event.target !== element) return;
      event.stopPropagation();
      handlers.current.flush();
      const multiplier =
        event.deltaMode === 1
          ? LINE_HEIGHT
          : event.deltaMode === 2
            ? height
            : 1;
      const delta = (value: number) =>
        Math.max(
          -SCROLL_LIMIT,
          Math.min(SCROLL_LIMIT, Math.round(value * multiplier)),
        );
      handlers.current.submit({
        type: 'browser.input',
        action: 'scroll',
        ...screenPoint(
          event.clientX,
          event.clientY,
          element.getBoundingClientRect(),
          width,
          height,
        ),
        deltaX: delta(event.deltaX),
        deltaY: delta(event.deltaY),
      });
    };
    document.addEventListener('wheel', wheel, { passive: false });
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('blur', leave);
    document.addEventListener('visibilitychange', leave);
    return () => {
      document.removeEventListener('wheel', wheel);
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('blur', leave);
      document.removeEventListener('visibilitychange', leave);
    };
  }, [screen, interactive, width, height]);
}
