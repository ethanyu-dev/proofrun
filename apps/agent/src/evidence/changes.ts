import type { Observation, ObservedTarget } from './observation.js';

/** 差分只提供近期重点，完整当前正文仍作为证据保存。 */
const CHANGED_TEXT_CHARS = 6000;
/** 观察编号变化不属于业务进展，也不能成为旧元素重放凭据。 */
const TARGET_MARKER = /\s*\[target=[^\]]+\]|\bref=[^,\]\s]+/g;
/** 在操作没有改变事实时先提示恢复，再由公共执行器停止重复调用。 */
export const STALLED_ROUNDS = 6;
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

/** 两份真实观察之间的差异；新出现只代表新观察到，不证明由上一步操作导致。 */
export interface ObservationChanges {
  /** 首轮或切换观察范围时不做跨范围增删推断。 */
  baseline: boolean;
  /** 新观察到的当前引用，包含进入视口的既有节点。 */
  added: string[];
  /** 节点身份未变但语义或操作状态变化的当前引用。 */
  updated: string[];
  /** 不再观察到的数量，无法可靠比较时为未知；不证明节点已从 DOM 删除。 */
  removedCount: number | null;
  /** 当前正文中新增的有界行片段。 */
  text: string;
  /** 差分正文是否有未发送部分。 */
  textTruncated: boolean;
  /** 上下文裁剪可能移除变化引用，不能把空数组解释为没有变化。 */
  refsTruncated: boolean;
  /** 连续观察中正文和控件状态都未改变的次数。 */
  unchangedRounds: number;
  /** 最近八次观察内同一语义状态出现的次数，识别 A→B→A 循环。 */
  repeatedStateVisits: number;
}

/** 独立于模型与动作编号保留比较基线；模型重规划不会清除停滞计数。 */
export class ObservationTracker {
  private previous: Observation | undefined;
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
    const added: string[] = [],
      updated: string[] = [];
    for (const target of page.targets) {
      delete target.change;
      if (baseline || !target.comparisonKey) continue;
      const old = before.get(target.comparisonKey);
      if (!old) {
        target.change = 'added';
        added.push(target.target);
      } else if (targetState(old) !== targetState(target)) {
        target.change = 'updated';
        updated.push(target.target);
      }
    }
    const currentKeys = new Set(page.targets.map((t) => t.comparisonKey));
    const removedCount =
      baseline ||
      page.truncated ||
      previous.truncated ||
      before.size !== previous.targets.length ||
      page.targets.some((t) => !t.comparisonKey)
        ? null
        : [...before.keys()].filter((key) => !currentKeys.has(key)).length;
    const normalize = (text: string) => text.replace(TARGET_MARKER, '').trim();
    const lines = new Set(
      (baseline ? '' : previous.text).split('\n').map(normalize),
    );
    const changedText = baseline
      ? ''
      : page.text
          .split('\n')
          .filter((line) => !lines.has(normalize(line)))
          .join('\n');
    const fingerprint = JSON.stringify([
      page.url,
      normalize(page.text),
      page.targets.map(targetState).sort(),
    ]);
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
    this.previous = structuredClone(page);
    return {
      baseline,
      added,
      updated,
      removedCount,
      text: changedText.slice(0, CHANGED_TEXT_CHARS),
      textTruncated: changedText.length > CHANGED_TEXT_CHARS,
      refsTruncated: false,
      unchangedRounds: this.unchanged,
      repeatedStateVisits,
    };
  }
}
