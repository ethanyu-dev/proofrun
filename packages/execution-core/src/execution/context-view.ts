import type { AgentDecision } from '@proofrun/contracts';
import type { Observation } from '../evidence/observation.js';
import { AgentFault } from '../faults.js';

/** 列表默认只展示少量诊断样本，主动分页保持固定上限，不改变总 context 预算。 */
const RUNTIME_PREVIEW = 2;
const RUNTIME_PAGE_SIZE = 20;
/** 重复视图遵循网络读取相同的两轮保护，回执正文最多保留八项。 */
const MAX_STALE_READS = 2;
const READ_RECEIPT_LIMIT = 8;

/** 只读选择始终绑定同一次观察；重新采集后不能恢复旧控件或旧运行时列表。 */
export type ContextSelection = Omit<
  Extract<AgentDecision, { type: 'context.read' }>,
  'type' | 'progress'
>;

/** 列表目录保留采集完整性与投影缺口，零条与未采集有明确区别。 */
export interface RuntimeList {
  /** 工具只能使用目录提供的精确路径。 */
  path: string;
  /** 原观察实际捕获的条目数，不代表站点全量。 */
  total: number;
  /** 当前摘要实际交付的样本数。 */
  returned: number;
  /** 当前投影省略数，与浏览器采集截断分开。 */
  omitted: number;
  /** 从该偏移可补读摘要尚未交付的条目。 */
  nextOffset: number | null;
  /** 保留原列表父对象的采集声明；未知值不推断为完整。 */
  capture: { complete: unknown; truncated: unknown };
}

/** 只遍历对象内的列表；条目内部不再递归，分页始终返回完整原始条目。 */
function runtimeArrays(runtime: Observation['runtime']) {
  const lists: Array<{
    path: string;
    parent: Record<string, unknown>;
    key: string;
    entries: unknown[];
    capture: RuntimeList['capture'];
  }> = [];
  const visit = (value: unknown, prefix: string) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const [key, item] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (Array.isArray(item)) {
        const parent = value as Record<string, unknown>;
        lists.push({
          path,
          parent,
          key,
          entries: item,
          capture: {
            complete: parent.complete ?? null,
            truncated: parent.truncated ?? null,
          },
        });
      } else if (key !== 'coverage') visit(item, path);
    }
  };
  visit(runtime, '');
  return lists;
}

/** 验证目录路径、快照与分页，不接受任意对象访问或当前列表以外的身份。 */
export function selectContext(
  page: Observation,
  selection: ContextSelection,
): ContextSelection {
  if (selection.observationId !== page.observationId)
    throw new AgentFault(
      'INVALID_MODEL_DECISION',
      'context_read 只能读取当前 observationId',
    );
  if (selection.section === 'runtime') {
    const list = runtimeArrays(page.runtime).find(
      (item) => item.path === selection.path,
    );
    const offset = selection.offset ?? 0;
    if (
      !list ||
      !Number.isInteger(offset) ||
      offset < 0 ||
      (offset > 0 && offset >= list.entries.length)
    )
      throw new AgentFault(
        'INVALID_MODEL_DECISION',
        '运行时路径或偏移不属于当前 runtimeLists',
      );
  }
  return {
    observationId: selection.observationId,
    section: selection.section,
    ...(selection.path ? { path: selection.path } : {}),
    ...(selection.offset !== undefined ? { offset: selection.offset } : {}),
  };
}

/** 摘要修改副本，采集标记留在目录中；原始观察与归档永远不被分页和裁剪覆盖。 */
export function runtimeContext(
  page: Observation,
  selection?: ContextSelection,
) {
  const runtime = structuredClone(page.runtime);
  const lists = runtimeArrays(runtime);
  const runtimeLists: RuntimeList[] = lists.map((list) => {
    const total = list.entries.length;
    // 缓存条目常占据几十 KB，默认不交付；错误等其它列表保留两个样本。
    const returned =
      list.path === 'cacheStorage.entries'
        ? 0
        : Math.min(total, RUNTIME_PREVIEW);
    list.parent[list.key] = list.entries.slice(0, returned);
    if (returned < total) {
      list.parent.complete = false;
      list.parent.truncated = true;
    }
    return {
      path: list.path,
      total,
      returned,
      omitted: total - returned,
      nextOffset: returned < total ? returned : null,
      capture: list.capture,
    };
  });
  const selected =
    selection?.observationId === page.observationId &&
    selection.section === 'runtime'
      ? lists.find((list) => list.path === selection.path)
      : undefined;
  const offset = selection?.offset ?? 0;
  const end = selected
    ? Math.min(selected.entries.length, offset + RUNTIME_PAGE_SIZE)
    : 0;
  return {
    runtime,
    runtimeLists: runtimeLists.length ? runtimeLists : undefined,
    runtimeDetail: selected
      ? {
          observationId: page.observationId,
          path: selected.path,
          offset,
          total: selected.entries.length,
          nextOffset: end < selected.entries.length ? end : null,
          capture: selected.capture,
          entries: structuredClone(selected.entries.slice(offset, end)),
          evidenceRefs: page.artifactRefs
            .filter((ref) => ref.kind === 'RUNTIME')
            .map((ref) => ref.artifactId),
        }
      : undefined,
  };
}

/** 已读页的轻量回执保留跨视图进展，不累计完整条目或将观察事实提升为验收结论。 */
export class ContextReads {
  /** 真实观察身份是读取回执的作用域。 */
  private observationId = '';
  /** 去重保留全量键，展示时才截取有界回执。 */
  private receipts = new Map<
    string,
    {
      section: 'page' | 'runtime';
      path?: string;
      offset?: number;
      returned?: number;
      nextOffset?: number | null;
      responseStatuses?: Array<{ status: string; count: number }>;
      evidenceRefs: string[];
    }
  >();
  /** 连续无新读取的次数，不因页面/运行时互切而清零。 */
  private stale = 0;

  /** 切换真实观察后旧回执失效，视图切换不重置读取进度。 */
  private sync(page: Observation) {
    if (this.observationId === page.observationId) return;
    this.observationId = page.observationId;
    this.receipts.clear();
    this.stale = 0;
  }
  /** 新结论才允许有限重读；单纯切回页面不能恢复循环额度。 */
  progressed() {
    this.stale = 0;
  }
  /** 只登记已验证的当前快照页；连续重复同页或交替旧视图会明确终止。 */
  read(page: Observation, selection: ContextSelection) {
    selectContext(page, selection);
    this.sync(page);
    const offset = selection.offset ?? 0;
    const key = JSON.stringify([selection.section, selection.path, offset]);
    this.stale = this.receipts.has(key) ? this.stale + 1 : 0;
    if (this.stale >= MAX_STALE_READS) return false;
    if (selection.section === 'runtime') {
      const list = runtimeArrays(page.runtime).find(
        (item) => item.path === selection.path,
      )!;
      const entries = list.entries.slice(offset, offset + RUNTIME_PAGE_SIZE);
      const statuses = new Map<string, number>();
      // 只汇总缓存实际状态码；不从缺失字段或其它运行时事件推断成功。
      if (selection.path === 'cacheStorage.entries')
        for (const entry of entries) {
          const status = String(
            (entry as Record<string, unknown>)?.responseStatus ?? 'unknown',
          );
          statuses.set(status, (statuses.get(status) ?? 0) + 1);
        }
      this.receipts.set(key, {
        section: 'runtime',
        path: selection.path!,
        offset,
        returned: entries.length,
        nextOffset:
          offset + entries.length < list.entries.length
            ? offset + entries.length
            : null,
        ...(statuses.size
          ? {
              responseStatuses: [...statuses].map(([status, count]) => ({
                status,
                count,
              })),
            }
          : {}),
        evidenceRefs: page.artifactRefs
          .filter((ref) => ref.kind === 'RUNTIME')
          .map((ref) => ref.artifactId),
      });
    } else
      this.receipts.set(key, {
        section: 'page',
        evidenceRefs: page.artifactRefs
          .filter((ref) => ref.kind === 'DOM')
          .map((ref) => ref.artifactId),
      });
    return true;
  }
  /** 展示最近八页回执；去重账本仍保留本观察的全部读取，不能换页绕过保护。 */
  view(page: Observation) {
    this.sync(page);
    return structuredClone(
      [...this.receipts.values()].slice(-READ_RECEIPT_LIMIT),
    );
  }
}
