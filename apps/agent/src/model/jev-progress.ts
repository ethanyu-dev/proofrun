import { createHash } from 'node:crypto';
import type { Observation } from '../evidence/observation.js';
import { observationState } from '../evidence/changes.js';
import { lowActionBudgetReview } from '../prompts/jev.js';

/** 有界证据记忆保留不同页面，不能将元素编号变化当成新信息。 */
const PAGE_LIMIT = 8;
/** 连续有新事实时不按轮数强制审查；重复状态审查后给恢复动作两个观察的执行窗口。 */
const REVIEW_COOLDOWN = 2;
const ELEMENT_REFS = /\s*\[target=[^\]]+\]|\bref=[^,\]\s]+/g;
export { evidenceExcerpt } from './evidence-excerpt.js';
import { evidenceExcerpt } from './evidence-excerpt.js';

/** 保存实际观察，而不是模型猜测的任务完成度；实例仅属于当前执行。 */
export class JevProgress {
  /** 按去除临时元素身份后的内容指纹保存证据片段及来源。 */
  private pages = new Map<
    string,
    {
      /** 证据采集页面地址。 */
      url: string;
      /** 当次观察的页面标题。 */
      title: string;
      /** 去除旧元素身份的相关正文片段。 */
      text: string;
      /** 实际观察的证据来源，供最终报告引用。 */
      artifactRefs: Observation['artifactRefs'];
      /** 片段不能代表未展示内容不存在。 */
      truncated: boolean;
      /** 相同内容状态的访问次数，不代表验收覆盖。 */
      visits: number;
    }
  >();
  /** 同一观察上的供应商重试不重复累计访问次数。 */
  private observationId = '';
  /** 同时比较正文和控件状态，展开或滚动变化不能被误判为正文停滞。 */
  private previous = '';
  /** 自上次 LLM 检查以来连续未获得新内容的次数。 */
  private unchanged = 0;
  /** 定期交给 LLM 核对任务进度，避免局部分类器承担无限规划。 */
  private rounds = 0;
  /** 只对新观察登记；旧元素身份不进入可操作目标列表。 */
  observe(page: Observation, objective: string) {
    if (page.observationId === this.observationId) return;
    this.observationId = page.observationId;
    const text = page.text.replace(ELEMENT_REFS, '');
    const key = createHash('sha256')
      .update(observationState(page))
      .digest('hex');
    this.unchanged = key === this.previous ? this.unchanged + 1 : 0;
    this.previous = key;
    this.rounds++;
    const old = this.pages.get(key);
    this.pages.delete(key);
    this.pages.set(key, {
      url: page.url,
      title: page.title,
      text: evidenceExcerpt(text, objective, 2000),
      artifactRefs: page.artifactRefs,
      truncated: text.length > 2000,
      visits: (old?.visits ?? 0) + 1,
    });
    while (this.pages.size > PAGE_LIMIT)
      this.pages.delete(this.pages.keys().next().value!);
  }
  /** 低预算、信息停滞、返回旧页面与定期检查均交给 LLM，不等动作耗尽。 */
  reviewReason(actions: number, recovering = false): string | undefined {
    if (actions <= 3) return lowActionBudgetReview(actions);
    if (recovering) return;
    if (this.unchanged >= 2)
      return '连续两次观察没有新增正文，检查是否重复滚动或等待';
    if (
      this.rounds >= REVIEW_COOLDOWN &&
      (this.pages.get(this.previous)?.visits ?? 0) >= 3
    )
      return '已反复返回相同页面状态，请核对已查栏目，避免重新搜索';
  }
  /** 检查结果仍由执行器验证；这里只重置检查间隔，不伪造任务通过。 */
  reviewed() {
    this.rounds = 0;
    this.unchanged = 0;
  }
  /** 新阶段有证据记录时允许再次访问旧页面；仅换计划或 activeStep 不触发重置。 */
  advanced() {
    this.reviewed();
    this.previous = '';
    for (const page of this.pages.values()) page.visits = 0;
  }
  /** 可引用历史来自实际 DOM，明确片段限制，不把访问次数视为覆盖完成。 */
  history() {
    return [...this.pages.values()];
  }
  /** 提供有限的进度事实，不包含任何凭据或浏览器内部身份。 */
  summary() {
    return {
      distinctRetainedStates: this.pages.size,
      unchangedObservations: this.unchanged,
      roundsSinceReview: this.rounds,
    };
  }
}
