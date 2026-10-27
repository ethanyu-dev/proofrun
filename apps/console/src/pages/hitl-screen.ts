import { useEffect, useRef, type RefObject } from 'react';
import type { NodeCommand } from '@proofrun/contracts';
import { bindHitlPointer, screenPoint } from './hitl-pointer';
export { screenPoint } from './hitl-pointer';

/** 与协议滚动上限一致；行模式滚轮按常见行高换算为 CSS 像素。 */
const SCROLL_LIMIT = 2000;
const LINE_HEIGHT = 16;

/** 只在画面持有焦点时锁住宿主页面；不影响下面表单的正常滚动。 */
export function useHitlScreen({
  screen,
  interactive,
  width,
  height,
  flush,
  submit,
  release,
  dragging,
  error,
}: {
  screen: RefObject<HTMLImageElement | null>;
  interactive: boolean;
  width: number;
  height: number;
  flush: () => void;
  submit: (command: NodeCommand['command']) => boolean;
  release: () => void;
  dragging: (active: boolean) => void;
  error: (message: string) => void;
}) {
  // 回调读取当前连接与队列，避免每一帧重新绑定全局监听器。
  const handlers = useRef({ flush, submit, release, dragging, error });
  handlers.current = { flush, submit, release, dragging, error };
  useEffect(() => {
    const element = screen.current;
    if (!interactive || !element) {
      element?.blur();
      handlers.current.release();
      return;
    }
    let pointerActive = false;
    const unbindPointer = bindHitlPointer(element, width, height, {
      flush: () => handlers.current.flush(),
      submit: (command) => handlers.current.submit(command),
      changed: (active) => {
        pointerActive = active;
        handlers.current.dragging(active);
      },
      error: (message) => handlers.current.error(message),
    });
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
      if (event.target !== element || pointerActive) return;
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
      unbindPointer();
      document.removeEventListener('wheel', wheel);
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('blur', leave);
      document.removeEventListener('visibilitychange', leave);
    };
  }, [screen, interactive, width, height]);
}
