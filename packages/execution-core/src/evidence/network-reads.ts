import { createHash } from 'node:crypto';
import type { AgentDecision } from '@proofrun/contracts';
import type { Observation } from './observation.js';
import {
  networkView,
  selectNetwork,
  type NetworkSelection,
} from './network-view.js';
import { AgentFault } from '../faults.js';

/** 只兼容有限批量的本地读取，不能把浏览器动作混入批次。 */
export const MAX_NETWORK_READS = 4;
/** 连续两轮只读过往结果便终止；A/B 交替与单项重复使用相同额度。 */
const MAX_STALE_ROUNDS = 2;
/** 模型只接收最近八条简短回执，去重集合仍保留当前快照的全部查询。 */
const RECENT_READS = 8;

/** 网络读取只是当前已交付快照的投影，不允许产生浏览器副作用。 */
export type NetworkReadDecision = Extract<
  AgentDecision,
  { type: 'network.requests' | 'network.request_detail' }
>;

/** 回执保留筛选结果，包括零匹配；不复制响应头或完整列表。 */
export interface NetworkReadReceipt {
  /** 查询参数已规范化，观察身份只说明读取来源。 */
  query: NetworkSelection;
  /** 当前快照中匹配记录总数，零条不证明未采集区间也没有请求。 */
  matched: number;
  /** 详情的地址和状态只作已读提示，完整元数据仍按需展示。 */
  request?: { id: string; url: string; status: number | null };
}

/** 每个步骤独立维护读取历史；观察 ID 改变但网络内容不变时，不能重置循环保护。 */
export class NetworkReads {
  /** 脱敏网络内容的版本，不依赖每次观察生成的 UUID。 */
  private scope = '';
  /** 当前快照已处理的规范查询，不因批次换序而遗忘。 */
  private seen = new Set<string>();
  /** 发给模型的有限摘要，与完整去重集合分开保存。 */
  private receipts: NetworkReadReceipt[] = [];
  /** 最近新增查询或有效结论之后，只读旧结果的连续轮数。 */
  private staleRounds = 0;

  /** 新的网络事实才切换快照；调用者取得的新观察仍需要通过 observationId 校验。 */
  private sync(page: Observation) {
    const network = structuredClone(page.network);
    // 快照时间随每次观察增长，不代表新请求或覆盖边界改变；其余覆盖字段仍参与事实身份。
    if (network && typeof network === 'object' && !Array.isArray(network)) {
      const coverage = (network as Record<string, unknown>).coverage;
      if (coverage && typeof coverage === 'object' && !Array.isArray(coverage))
        delete (coverage as Record<string, unknown>).capturedAt;
    }
    const scope = createHash('sha256')
      .update(JSON.stringify([page.url, network]))
      .digest('hex');
    if (scope === this.scope) return;
    this.scope = scope;
    this.seen.clear();
    this.receipts = [];
    this.staleRounds = 0;
  }

  /** 真实结论登记允许重新核对，但不能通过更换查询顺序或仅更新计划重置次数。 */
  progressed() {
    this.staleRounds = 0;
  }

  /** 验证整批后一次更新账本，任一非法查询都不会留下部分成功状态。 */
  read(page: Observation, decisions: NetworkReadDecision[]) {
    if (!decisions.length || decisions.length > MAX_NETWORK_READS)
      throw new AgentFault(
        'INVALID_MODEL_DECISION',
        `网络读取批次最多 ${MAX_NETWORK_READS} 项`,
      );
    const selections = decisions.map(
      ({ type: _type, progress: _progress, ...selection }) =>
        selectNetwork(page, selection),
    );
    this.sync(page);
    const entries = [
      ...new Map(
        selections.map((selection) => {
          const { observationId: _id, ...query } = selection;
          return [JSON.stringify(query), selection] as const;
        }),
      ).entries(),
    ];
    const novel = entries.some(([key]) => !this.seen.has(key));
    this.staleRounds = novel ? 0 : this.staleRounds + 1;
    if (this.staleRounds >= MAX_STALE_ROUNDS) return undefined;
    for (const [key, selection] of entries) {
      const view = networkView(page, selection)!;
      if (!this.seen.has(key)) {
        this.receipts.push({
          query: selection,
          matched: view.matched,
          ...(view.detail
            ? {
                request: {
                  id: view.detail.id,
                  url: String(view.detail.captured.url),
                  status:
                    typeof view.detail.captured.status === 'number'
                      ? view.detail.captured.status
                      : null,
                },
              }
            : {}),
        });
        this.receipts = this.receipts.slice(-RECENT_READS);
      }
      this.seen.add(key);
    }
    return entries.map(([, selection]) => selection);
  }

  /** 查询回执只在同一网络快照内有效；返回副本防止上下文裁剪污染账本。 */
  view(page: Observation) {
    this.sync(page);
    return structuredClone(this.receipts);
  }
}

/** 列表和最近展开详情各保留一份，切换查询不会抹掉已读的零匹配结果或响应头。 */
export function retainNetworkSelection(
  previous: NetworkSelection | undefined,
  next: NetworkSelection,
): NetworkSelection {
  if (previous?.observationId !== next.observationId) return next;
  return next.requestId
    ? { ...previous, ...next }
    : {
        ...next,
        ...(previous.requestId ? { requestId: previous.requestId } : {}),
      };
}
