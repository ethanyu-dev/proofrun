import type { Observation, ObservedTarget } from '../evidence/observation.js';
import { targetState } from '../evidence/changes.js';
import { AgentFault } from '../http.js';

/** 子项证据有独立上限，不依靠反复登记增加动作预算。 */
const ITEM_LIMIT = 32;
/** 同一目标最多两次真实前置失败；观察编号变化不能重置额度。 */
const FAILURE_LIMIT = 2;

/** 页面身份与稳定 DOM 比较键只用于进度归属，绝不能作为浏览器动作 target。 */
function key(page: Observation, target: ObservedTarget) {
  return JSON.stringify([
    page.url,
    target.frame,
    target.comparisonKey ?? [
      target.region?.key,
      target.context?.heading,
      target.role,
      target.name,
    ],
  ]);
}

/** 读取记录表示对应面板已取得证据，语言和业务是否通过仍由原验收项判定。 */
interface Reading {
  /** 执行器分配的步骤内身份，不可用作 DOM target。 */
  id: string;
  /** 控件在观察中的名称，用于报告定位。 */
  name: string;
  /** 邻近标题只描述区域线索。 */
  heading: string;
  /** 读取进度独立于原验收结论。 */
  status: 'pending' | 'observed' | 'recorded';
  /** 未裁剪的面板原文仅在当前步骤内校验引文。 */
  text: string;
  /** 对应实际观察的证据身份，不能接受模型自填附件。 */
  evidenceRefs: string[];
  /** 已验证为原文片段的模型读取记录。 */
  quote?: string;
}

/** 每个业务步骤独立追踪子项与失败目标；人工改变环境时丢弃，不能跨账号复用。 */
export class InteractionProgress {
  private items = new Map<string, Reading>();
  private failures = new Map<string, { count: number; state: string }>();
  private nextId = 1;
  /** 最终阻塞保留原始浏览器故障分类，不用恢复策略名称覆盖根因。 */
  recoveryReason = 'BROWSER_ACTION_PRECONDITION_FAILED';
  private revision = 0;

  /** 即使面板后来关闭或移出视口，也保留之前的读取证据，避免重复点击。 */
  observe(page: Observation) {
    for (const target of page.targets) {
      if (!target.disclosure) continue;
      const identity = key(page, target);
      let item = this.items.get(identity);
      if (!item && this.items.size < ITEM_LIMIT) {
        item = {
          id: `item-${this.nextId++}`,
          name: target.name,
          heading: target.context?.heading ?? target.region?.name ?? '',
          status: 'pending',
          text: '',
          evidenceRefs: [],
        };
        this.items.set(identity, item);
      }
      if (!item || item.status === 'recorded') continue;
      const panel = target.disclosure;
      if (
        panel.visible &&
        panel.text.trim() &&
        !panel.truncated &&
        !page.truncated &&
        panel.expanded !== false
      ) {
        item.status = 'observed';
        item.text = panel.text;
        item.evidenceRefs = page.artifactRefs.map((r) => r.artifactId);
      }
    }
  }

  /** 引文必须来自这个子项真实关联的已观察面板；不能用点击成功或其它区域文案代替。 */
  validate(readings: unknown): Array<{ item: Reading; quote: string }> {
    if (readings === undefined) return [];
    const invalid = () =>
      new AgentFault(
        'INVALID_MODEL_DECISION',
        '子项读取记录必须引用已观察面板的原文；未知、隐藏或裁剪内容不能算已读取',
      );
    if (!Array.isArray(readings) || readings.length > ITEM_LIMIT)
      throw invalid();
    const seen = new Set<string>();
    return readings.map((value) => {
      const item =
        value && [...this.items.values()].find((i) => i.id === value.itemId);
      if (
        !item ||
        seen.has(item.id) ||
        !['observed', 'recorded'].includes(item.status) ||
        Object.keys(value).some((k) => !['itemId', 'quote'].includes(k)) ||
        typeof value.quote !== 'string' ||
        !value.quote.trim() ||
        value.quote.length > 600 ||
        !item.text.includes(value.quote) ||
        !item.evidenceRefs.length
      )
        throw invalid();
      seen.add(item.id);
      return { item, quote: value.quote };
    });
  }

  /** 只有首次登记真实读取才推进，重复提交不会重置循环检测。 */
  record(readings: ReturnType<InteractionProgress['validate']>) {
    for (const { item, quote } of readings) {
      if (item.status === 'recorded') continue;
      item.status = 'recorded';
      item.quote = quote;
      this.revision++;
    }
  }

  /** 保留语义与位置条件；仅重新取 observationId 不视为恢复。 */
  private state(page: Observation, target: ObservedTarget) {
    return JSON.stringify([
      page.viewport,
      targetState(target),
      target.context,
      target.disclosure,
      page.targets.map(targetState).sort(),
    ]);
  }

  /** 失败后必须改变目标或其操作条件，且不能无界重试同一目标。 */
  assertClick(page: Observation, target: ObservedTarget) {
    const failed = this.failures.get(key(page, target));
    if (
      failed &&
      (failed.count >= FAILURE_LIMIT ||
        failed.state === this.state(page, target))
    )
      throw new AgentFault(
        'INTERACTION_RECOVERY_REQUIRED',
        `目标「${target.name}」点击前置检查已失败；请调整滚动或处理遮挡，不能只刷新观察后重复点击。同一目标最多两次失败。`,
      );
  }

  /** 只记录明确未派发的前置失败；未知写入仍由执行器立即停止。 */
  failedClick(
    page: Observation,
    target: ObservedTarget,
    code = 'DOM_ACTION_PRECONDITION_FAILED',
  ) {
    this.recoveryReason =
      code === 'TARGET_OBSCURED'
        ? 'BROWSER_TARGET_OBSCURED'
        : 'BROWSER_ACTION_PRECONDITION_FAILED';
    const identity = key(page, target);
    this.failures.set(identity, {
      count: (this.failures.get(identity)?.count ?? 0) + 1,
      state: this.state(page, target),
    });
  }

  /** 面板完整正文保留在证据中；上下文只保留有界摘录和稳定进度。 */
  view() {
    return {
      revision: this.revision,
      // 优先展示已展开但未登记的内容，裁剪不能让后面的新问题永远不可见。
      items: [...this.items.values()]
        .sort(
          (a, b) =>
            Number(b.status === 'observed') - Number(a.status === 'observed'),
        )
        .map((item) => ({
          ...structuredClone(item),
          text: item.status === 'recorded' ? '' : item.text.slice(0, 400),
        })),
      limit: ITEM_LIMIT,
      omittedItems: 0,
    };
  }
  /** 报告保留读取来源，不将它转换为 PASSED。 */
  results() {
    return [...this.items.values()].map(({ text: _text, ...item }) =>
      structuredClone(item),
    );
  }
}
