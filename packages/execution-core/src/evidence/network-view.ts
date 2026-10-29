import { createHash } from 'node:crypto';
import type { Observation } from './observation.js';
import { AgentFault } from '../faults.js';

/** 默认只展开一页摘要；剩余请求通过筛选或偏移读取，不丢弃原始记录。 */
const PAGE_SIZE = 20;
/** 未主动查询时只展示发现线索，完整分页仍由 network.requests 按需读取。 */
const PREVIEW_SIZE = 5;

/** 查询状态绑定观察快照；页面刷新后不能把旧详情当成当前事实。 */
export interface NetworkSelection {
  /** 读取时的观察身份，也是分页的一致性边界。 */
  observationId: string;
  /** 摘要列表的地址子串筛选，不解释为正则表达式。 */
  urlContains?: string;
  /** null 专门筛选尚未收到响应的请求。 */
  status?: number | null;
  /** 在筛选结果中的起始位置。 */
  offset?: number;
  /** 只保留最近一次主动读取的详情，避免跨轮积累。 */
  requestId?: string;
}

/** 摘要不携带响应头、图片参数或内部 CDP 字段。 */
export interface RequestSummary {
  /** 节点有请求身份时跨观察稳定；旧记录与探测保守绑定观察，重定向各跳独立编号。 */
  id: string;
  /** 节点已经脱敏的请求地址。 */
  url: string;
  /** 已观察到的方法；旧记录未提供时保持未知。 */
  method: string | null;
  /** 尚未收到响应时为 null，不能解释成成功或失败。 */
  status: number | null;
}

/** 从已采集证据生成视图；此模块没有网络客户端，也不能重放请求。 */
function snapshot(page: Observation) {
  const network = page.network;
  if (!network || typeof network !== 'object' || Array.isArray(network))
    return undefined;
  const source = network as Record<string, unknown>;
  if (!Array.isArray(source.requests)) return undefined;
  const evidenceRefs = page.artifactRefs
    .filter((ref) => ref.kind === 'NETWORK')
    .map((ref) => ref.artifactId);
  const rows = source.requests.filter(
    (row): row is Record<string, unknown> =>
      !!row && typeof row === 'object' && typeof row.url === 'string',
  );
  const occurrences = new Map<string, number>();
  const entries = rows.map((row) => {
    // CDP 在重定向链中复用 requestId；时间与地址区分各跳，同地址同时间仍按出现次数区分。
    const identity = JSON.stringify([
      source.targetId,
      source.navigationId,
      row.requestId ?? page.observationId,
      row.timestamp,
      row.url,
      row.method,
    ]);
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    const id = `request-${createHash('sha256').update(`${identity}:${occurrence}`).digest('hex').slice(0, 32)}`;
    return { id, row };
  });
  // 公开探测不是页面请求；沿用独立范围，并仅在主动取详情时展示参数与响应头。
  if (source.probe && typeof source.probe === 'object') {
    const row = source.probe as Record<string, unknown>;
    if (typeof row.url === 'string')
      entries.push({
        id: `probe-${createHash('sha256')
          .update(JSON.stringify([page.observationId, row]))
          .digest('hex')
          .slice(0, 32)}`,
        row: { ...row, method: 'GET' },
      });
  }
  return { source, entries, evidenceRefs };
}

/** 每次投影只返回摘要与最多一条详情；证据内容和所属观察均不被修改。 */
function singleNetworkView(
  page: Observation,
  selection?: NetworkSelection,
  pageSize = PAGE_SIZE,
) {
  const captured = snapshot(page);
  if (!captured) return undefined;
  const { source, entries, evidenceRefs } = captured;
  const query =
    selection?.observationId === page.observationId ? selection : undefined;
  const summaries: RequestSummary[] = entries.map(({ id, row }) => ({
    id,
    url: row.url as string,
    method: typeof row.method === 'string' ? row.method : null,
    status: typeof row.status === 'number' ? row.status : null,
  }));
  const matched = summaries.filter(
    (row) =>
      (!query?.urlContains || row.url.includes(query.urlContains)) &&
      (query?.status === undefined || row.status === query.status),
  );
  const offset = query?.offset ?? 0;
  const requests = matched.slice(offset, offset + pageSize);
  const selectedIndex = entries.findIndex(
    (entry) => entry.id === query?.requestId,
  );
  const selected = entries[selectedIndex];
  // 同一重定向链之间可夹有其它资源请求，不能仅以相邻数组位置关联。
  const previous = selected?.row.requestId
    ? entries
        .slice(0, selectedIndex)
        .findLast((entry) => entry.row.requestId === selected.row.requestId)
    : undefined;
  const next = selected?.row.requestId
    ? entries
        .slice(selectedIndex + 1)
        .find((entry) => entry.row.requestId === selected.row.requestId)
    : undefined;
  return {
    observationId: page.observationId,
    scope: source.scope ?? 'unknown',
    capture: {
      complete: source.complete === true,
      truncated: source.truncated === true,
      redacted: source.redacted === true,
      // 全局 complete 与明确窗口的覆盖分别表达；旧节点没有范围说明时仍保持未知。
      coverage:
        source.coverage && typeof source.coverage === 'object'
          ? structuredClone(source.coverage)
          : {
              scope: 'unknown',
              complete: false,
              reasons: ['COVERAGE_UNAVAILABLE'],
            },
    },
    evidenceRefs,
    total: entries.length,
    matched: matched.length,
    filter: { urlContains: query?.urlContains ?? null, status: query?.status },
    offset,
    requests,
    nextOffset:
      offset + requests.length < matched.length
        ? offset + requests.length
        : null,
    omitted: matched.length - requests.length,
    detail: selected
      ? {
          id: selected.id,
          observationId: page.observationId,
          evidenceRefs,
          captured: structuredClone(selected.row),
          redirectFromRequestId:
            previous?.row.redirect === true ? previous.id : null,
          redirectToRequestId:
            selected.row.redirect === true ? (next?.id ?? null) : null,
          availability:
            '仅包含已采集的脱敏元数据；未采集请求正文、响应正文及任意请求头。',
        }
      : null,
  };
}

/** 当前查询与同轮批次的其它结果一起投影；旧观察的批次不会进入新页面。 */
export function networkView(
  page: Observation,
  selection?: NetworkSelection,
  additionalSelections: NetworkSelection[] = [],
) {
  const view = singleNetworkView(page, selection);
  if (!view) return undefined;
  const additionalResults = additionalSelections
    .filter((item) => item.observationId === page.observationId)
    .map((item) => singleNetworkView(page, item)!);
  return {
    ...view,
    ...(additionalResults.length ? { additionalResults } : {}),
  };
}

/** 初次观察保留总数、覆盖和读取游标；不把有限预览当作全部网络证据。 */
export function networkOverview(
  page: Observation,
): ReturnType<typeof networkView> {
  return singleNetworkView(page, undefined, PREVIEW_SIZE);
}

/** 工具查询必须属于当前观察且有已交付 NETWORK 证据，不接受外部地址或任意附件。 */
export function selectNetwork(
  page: Observation,
  selection: NetworkSelection,
): NetworkSelection {
  const view = networkView(page, selection);
  if (
    selection.observationId !== page.observationId ||
    !view?.evidenceRefs.length
  )
    throw new AgentFault(
      'INVALID_MODEL_DECISION',
      '网络查询不属于当前观察或缺少已交付 NETWORK 证据，请使用当前 page.network。',
    );
  if (selection.requestId && !view.detail)
    throw new AgentFault(
      'INVALID_MODEL_DECISION',
      '请求 ID 不属于当前网络快照，请先查询摘要列表，不猜测请求身份。',
    );
  if ((selection.offset ?? 0) > view.matched)
    throw new AgentFault(
      'INVALID_MODEL_DECISION',
      '网络列表偏移超出筛选结果，请使用 nextOffset 或从 0 查询。',
    );
  // 规范化省略值和字段顺序，避免同一查询通过改写 JSON 排版绕过重复读取保护。
  return selection.requestId
    ? { observationId: selection.observationId, requestId: selection.requestId }
    : {
        observationId: selection.observationId,
        urlContains: selection.urlContains ?? '',
        ...(selection.status === undefined ? {} : { status: selection.status }),
        offset: selection.offset ?? 0,
      };
}

/** 预算裁剪仅减少当前页摘要，游标仍能补读；详情与采集覆盖标记保持原样。 */
export function trimNetworkView(view: ReturnType<typeof networkView>): boolean {
  if (!view) return false;
  const target = [view, ...(view.additionalResults ?? [])]
    .filter((item) => item.requests.length > 1)
    .sort((a, b) => b.requests.length - a.requests.length)[0];
  if (!target) return false;
  target.requests = target.requests.slice(
    0,
    Math.ceil(target.requests.length / 2),
  );
  target.nextOffset = target.offset + target.requests.length;
  target.omitted = target.matched - target.requests.length;
  return true;
}
