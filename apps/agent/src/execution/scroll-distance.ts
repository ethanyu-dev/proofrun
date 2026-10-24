import type { Observation } from '../evidence/observation.js';

/** 模型只表达方向；节点的像素幅度由执行器计算，不作为模型输入协议。 */
export const SCROLL_DIRECTIONS = ['up', 'down', 'left', 'right'] as const;

/** 页面阅读保留四分之一视口重叠，减少跨次观察间漏读。 */
const SCROLL_FRACTION = 0.75;
/** 容器按九成可视范围推进，保留重叠而不让窄列表耗费过多定位动作。 */
const CONTAINER_SCROLL_FRACTION = 0.9;
/** 与节点协议一致的单次滚动上限，单位为 CSS 像素。 */
const MAX_SCROLL = 1200;

/** 与节点协商后的滚动幅度；旧节点继续使用 400 像素。 */
export function scrollDistance(
  page: Observation,
  target?: string,
  horizontal = false,
): number {
  const viewport = page.viewport as Record<string, unknown> | undefined;
  if (viewport?.scrollDistance !== true) return 400;
  const container = page.targets.find((item) => item.target === target)?.scroll;
  const size = container
    ? horizontal
      ? container.width
      : container.height
    : Number(viewport[horizontal ? 'width' : 'height']);
  return Number.isFinite(size) && size > 0
    ? Math.round(
        Math.max(
          container ? 1 : 100,
          Math.min(
            MAX_SCROLL,
            size * (container ? CONTAINER_SCROLL_FRACTION : SCROLL_FRACTION),
          ),
        ),
      )
    : 400;
}
