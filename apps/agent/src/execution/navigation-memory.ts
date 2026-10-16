import type { Observation } from '../evidence/observation.js';

/** 定位线索有界保留；不储存历史 target、字段值或可执行选择器。 */
const MAX_LOCATIONS = 64;
/** 每轮仅提供最相关的少量定位线索，限制上下文占用。 */
const MAX_HINTS = 6;
/** 相邻观察保留四分之一视口重叠，减少跨过内容的机会。 */
const SCROLL_FRACTION = 0.75;
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
    ? Math.round(Math.max(100, Math.min(MAX_SCROLL, size * SCROLL_FRACTION)))
    : 400;
}

/** 位置只是曾经观察到的线索，重新定位后必须使用当前目标。 */
interface Location {
  /** 线索采集时的页面地址。 */
  url: string;
  /** 仅定位范围，不能作为跨观察的执行授权。 */
  frame: string;
  /** 已观察的有界控件名称。 */
  name: string;
  /** 控件语义角色。 */
  role: string;
  /** 已观察的邻近标题。 */
  heading: string;
  /** 仅主文档普通流控件可估算文档纵坐标，嵌套容器不猜测绝对位置。 */
  documentY: number | null;
  /** 原始观察身份，供诊断关联来源。 */
  observationId: string;
}

/** 每个执行实例独立保存，控制代次改变时由调用方丢弃。 */
export class NavigationMemory {
  /** 按语义位置合并，避免持久化过期元素身份。 */
  private locations = new Map<string, Location>();

  /** 从真实可见控件取得线索，滚动容器和固定控件只保留语义。 */
  observe(page: Observation) {
    const viewport = page.viewport as { y?: number } | undefined;
    const main = page.documents?.find((item) => item.isMainFrame)?.frameId;
    const nested = page.targets.some((item) => item.scroll);
    for (const target of page.targets) {
      if (target.visible === false || !target.name.trim()) continue;
      const item: Location = {
        url: page.url,
        frame: target.frame ?? '',
        name: target.name.slice(0, 160),
        role: target.role,
        heading: target.context?.heading.slice(0, 160) ?? '',
        documentY:
          !nested &&
          !target.context?.fixed &&
          (!target.frame || target.frame === main) &&
          target.clip &&
          Number.isFinite(viewport?.y)
            ? viewport!.y! + target.clip.top
            : null,
        observationId: page.observationId,
      };
      const key = JSON.stringify([
        item.url,
        item.frame,
        item.role,
        item.name,
        item.heading,
      ]);
      this.locations.delete(key);
      this.locations.set(key, item);
    }
    while (this.locations.size > MAX_LOCATIONS)
      this.locations.delete(this.locations.keys().next().value!);
  }

  /** 匹配词来自当前计划；位置过期不做存在性或可操作性保证。 */
  hints(page: Observation, terms: string[]) {
    const words = terms.map((term) => term.toLowerCase()).filter(Boolean);
    const viewport = page.viewport as
      { y?: number; height?: number } | undefined;
    return [...this.locations.values()]
      .filter((item) => item.url === page.url)
      .map((item) => ({
        item,
        score: words.filter((term) =>
          `${item.name} ${item.heading}`.toLowerCase().includes(term),
        ).length,
      }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_HINTS)
      .map(({ item }) => {
        const y = viewport?.y;
        const delta =
          item.documentY !== null && Number.isFinite(y)
            ? item.documentY - y!
            : null;
        return {
          ...item,
          historical: item.observationId !== page.observationId,
          direction:
            delta === null
              ? null
              : delta < 0
                ? 'up'
                : delta > (viewport?.height ?? 0)
                  ? 'down'
                  : null,
          estimatedScrolls:
            delta === null
              ? null
              : Math.ceil(
                  Math.max(
                    0,
                    delta < 0 ? -delta : delta - (viewport?.height ?? 0),
                  ) / scrollDistance(page),
                ),
        };
      });
  }
}
