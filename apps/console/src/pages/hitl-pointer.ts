import type { NodeCommand } from '@proofrun/contracts';

/** 与节点协议一致；整段手势有界提交，避免断线留下远端鼠标按住状态。 */
const MAX_GESTURE_MS = 8000;
/** 限制采样频率，使八秒手势加起止点不超过协议的 256 点。 */
const SAMPLE_MS = 32;
/** 使用本地 CSS 像素区分点击抖动与拖动，不随远端画面缩放改变。 */
const DRAG_THRESHOLD = 3;

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

/** 一次按住期间的本地轨迹；松手前不在远端产生副作用。 */
interface Gesture {
  /** 只接受发起手势的指针，忽略第二根手指。 */
  pointerId: number;
  /** 冻结手势开始时的画面尺寸，帧尺寸变化会通过卸载取消手势。 */
  rect: DOMRect;
  /** 单调时钟起点，用于保留人工移动节奏。 */
  started: number;
  /** 本地起点仅用于判定抖动。 */
  clientX: number;
  clientY: number;
  /** 曾经越过阈值即为拖动，移回原点也不能变成点击。 */
  dragged: boolean;
  /** 远端 CSS 视口坐标以及相对于按下的毫秒数。 */
  points: { x: number; y: number; atMs: number }[];
}

/** 绑定人工点击/拖拽；窗口级监听保证在图片外松手也能结束，取消则丢弃未提交轨迹。 */
export function bindHitlPointer(
  element: HTMLImageElement,
  width: number,
  height: number,
  callbacks: {
    /** 按下前先提交已输入的文字，保持操作顺序。 */
    flush: () => void;
    /** 完整手势作为单条命令入队，不拆成可能丢失松手的多条命令。 */
    submit: (command: NodeCommand['command']) => boolean;
    /** 手势期间禁用交接，避免尚未入队的轨迹越过控制权切换。 */
    changed: (active: boolean) => void;
    /** 超长操作明确提示取消，不能静默截断成另一段手势。 */
    error: (message: string) => void;
  },
) {
  let gesture: Gesture | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    const previous = gesture;
    gesture = undefined;
    clearTimeout(timer);
    if (!previous) return;
    if (element.hasPointerCapture?.(previous.pointerId))
      element.releasePointerCapture(previous.pointerId);
    callbacks.changed(false);
  };
  const down = (event: PointerEvent) => {
    if (event.button !== 0 || gesture || event.isPrimary === false) return;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    event.preventDefault();
    callbacks.flush();
    element.focus({ preventScroll: true });
    gesture = {
      pointerId: event.pointerId,
      rect,
      started: performance.now(),
      clientX: event.clientX,
      clientY: event.clientY,
      dragged: false,
      points: [
        {
          ...screenPoint(event.clientX, event.clientY, rect, width, height),
          atMs: 0,
        },
      ],
    };
    // 捕获可能因指针已失效被拒绝；窗口监听仍能处理正常松手。
    try {
      element.setPointerCapture?.(event.pointerId);
    } catch {}
    callbacks.changed(true);
    timer = setTimeout(() => {
      cancel();
      callbacks.error('拖动超过 8 秒，已取消。请重新拖动并松手。');
    }, MAX_GESTURE_MS);
  };
  const update = (event: PointerEvent, final: boolean) => {
    const current = gesture;
    if (!current || current.pointerId !== event.pointerId) return;
    event.preventDefault();
    const atMs = Math.round(performance.now() - current.started);
    if (atMs > MAX_GESTURE_MS) {
      cancel();
      callbacks.error('拖动超过 8 秒，已取消。请重新拖动并松手。');
      return;
    }
    const wasDragged = current.dragged;
    current.dragged ||=
      Math.hypot(
        event.clientX - current.clientX,
        event.clientY - current.clientY,
      ) >= DRAG_THRESHOLD;
    if (
      final ||
      (!wasDragged && current.dragged) ||
      atMs - current.points.at(-1)!.atMs >= SAMPLE_MS
    )
      current.points.push({
        ...screenPoint(
          event.clientX,
          event.clientY,
          current.rect,
          width,
          height,
        ),
        atMs,
      });
    if (!final) return;
    cancel();
    callbacks.submit(
      current.dragged
        ? {
            type: 'browser.input',
            action: 'drag',
            points: [
              current.points[0]!,
              current.points[1]!,
              ...current.points.slice(2),
            ],
          }
        : {
            type: 'browser.input',
            action: 'click',
            x: current.points[0]!.x,
            y: current.points[0]!.y,
          },
    );
  };
  const move = (event: PointerEvent) => {
    if (gesture?.pointerId === event.pointerId && !(event.buttons & 1)) {
      cancel();
      return;
    }
    update(event, false);
  };
  const up = (event: PointerEvent) => {
    if (event.button === 0) update(event, true);
  };
  const cancelled = (event: PointerEvent) => {
    if (gesture?.pointerId === event.pointerId) cancel();
  };
  // 浏览器随后合成的 click 不能把已提交的拖动再变成一次点击；保留键盘/程序 click。
  const click = (event: MouseEvent) => {
    if (event.detail > 0) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  const drag = (event: DragEvent) => event.preventDefault();
  element.addEventListener('pointerdown', down);
  element.addEventListener('lostpointercapture', cancelled);
  element.addEventListener('click', click);
  element.addEventListener('dragstart', drag);
  element.addEventListener('blur', cancel);
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancelled);
  window.addEventListener('blur', cancel);
  document.addEventListener('visibilitychange', cancel);
  return () => {
    cancel();
    element.removeEventListener('pointerdown', down);
    element.removeEventListener('lostpointercapture', cancelled);
    element.removeEventListener('click', click);
    element.removeEventListener('dragstart', drag);
    element.removeEventListener('blur', cancel);
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancelled);
    window.removeEventListener('blur', cancel);
    document.removeEventListener('visibilitychange', cancel);
  };
}
