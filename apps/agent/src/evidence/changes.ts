import type { Observation, ObservedTarget } from './observation.js';

/** 观察编号变化不属于业务进展，也不能成为旧元素重放凭据。 */
const TARGET_MARKER = /\s*\[target=[^\]]+\]|\bref=[^,\]\s]+/g;
/** 在操作没有改变事实时先提示恢复，再由公共执行器停止重复调用。 */
export const STALLED_ROUNDS = 6;
/** 两次无变化后撤下纯观察工具，保留登记结论、实际动作和明确受阻的选择。 */
export const OBSERVATION_REVIEW_ROUNDS = 2;
/** 在有限窗口中重复回到同一状态四次且无阶段证据进展时终止交替循环。 */
export const CYCLIC_VISITS = 4;
const CYCLE_WINDOW = 8;

/** 只比较语义与实际滚动状态，省略临时身份和装饰性几何信息。 */
export function targetState(t: ObservedTarget): string {
  return JSON.stringify([
    t.role,
    t.name,
    t.value,
    t.disabled,
    t.expanded,
    t.checked,
    t.selected,
    t.operations,
    t.scroll,
    t.options,
    // 区域语义变化属于事实变化；路径和 frame 临时身份不算业务进展。
    t.region ? [t.region.role, t.region.name, t.region.ancestors] : null,
  ]);
}

/** 所有模式共用状态身份；滚动位置表示搜索位置变化，不能当作验收进展。 */
export function observationState(page: Observation): string {
  return JSON.stringify([
    page.url,
    page.viewport,
    page.text.replace(TARGET_MARKER, '').trim(),
    page.documents?.map(({ url, lang }) => [url, lang]),
    page.targets.map(targetState).sort(),
  ]);
}

/** 只返回循环保护实际消费的计数；控件变化直接标注在当前目标上。 */
export interface ObservationChanges {
  /** 连续观察中正文和控件状态都未改变的次数。 */
  unchangedRounds: number;
  /** 最近八次观察内同一语义状态出现的次数，识别 A→B→A 循环。 */
  repeatedStateVisits: number;
}

/** 独立于模型与动作编号保留比较基线；模型重规划不会清除停滞计数。 */
export class ObservationTracker {
  /** 跨观察只保留控件比较所需字段，正文由独立进展指纹处理。 */
  private previous: Pick<Observation, 'url' | 'targets'> | undefined;
  private fingerprint = '';
  private unchanged = 0;
  /** 有界状态窗口；不因元素重编号或模型重规划清空。 */
  private states: string[] = [];

  /** 清除增删基线；自动导航保留进展指纹，避免重复刷新绕过停滞上限。 */
  reset(preserveProgress = false) {
    this.previous = undefined;
    if (!preserveProgress) {
      this.fingerprint = '';
      this.unchanged = 0;
      this.states = [];
    }
  }

  /** 比较原始完整观察后排序；仅上下文视图改变，不修改已保存的 DOM 证据。 */
  observe(page: Observation, countProgress = true): ObservationChanges {
    const previous = this.previous;
    const baseline = !previous || previous.url !== page.url;
    const before = new Map(
      (baseline ? [] : previous.targets)
        .filter((t) => t.comparisonKey)
        .map((t) => [t.comparisonKey, t]),
    );
    for (const target of page.targets) {
      delete target.change;
      if (baseline || !target.comparisonKey) continue;
      const old = before.get(target.comparisonKey);
      if (!old) {
        target.change = 'added';
      } else if (targetState(old) !== targetState(target)) {
        target.change = 'updated';
      }
    }
    const fingerprint = observationState(page);
    if (countProgress) {
      this.unchanged =
        fingerprint === this.fingerprint ? this.unchanged + 1 : 0;
      this.states.push(fingerprint);
      if (this.states.length > CYCLE_WINDOW) this.states.shift();
    }
    this.fingerprint = fingerprint;
    const repeatedStateVisits = this.states.filter(
      (s) => s === fingerprint,
    ).length;
    // 新出现和状态变化优先，同时保留未变化的弹层退出按钮。
    page.targets.sort(
      (a, b) =>
        Number(!!b.change) - Number(!!a.change) ||
        Number(!!b.activeRegion) - Number(!!a.activeRegion),
    );
    this.previous = { url: page.url, targets: structuredClone(page.targets) };
    return {
      unchangedRounds: this.unchanged,
      repeatedStateVisits,
    };
  }
}
