import { createHash } from 'node:crypto';
import type { Observation } from '../evidence/observation.js';
import { targetState } from '../evidence/changes.js';

/** 有界证据记忆保留不同页面，不能将元素编号变化当成新信息。 */
const PAGE_LIMIT = 8;
const EXCERPT_CHARS = 16000;
/** 连续有新事实时不按轮数强制审查；重复状态审查后给恢复动作两个观察的执行窗口。 */
const REVIEW_COOLDOWN = 2;
const ELEMENT_REFS = /\s*\[target=[^\]]+\]|\bref=[^,\]\s]+/g;
/** 从任务文字提取检索词，排除 URL，避免整站导航词压过业务主题。 */
const TASK_TERMS = /[\p{L}\p{N}][\p{L}\p{N}._-]{2,}/gu;

/** 长页面按任务相关段落选取；完整当前页仍由执行器提供给文本模型。 */
export function evidenceExcerpt(
  text: string,
  objective: string,
  limit = EXCERPT_CHARS,
): string {
  if (text.length <= limit) return text;
  const terms = [
    ...new Set(
      (objective.replace(/https?:\/\/\S+/g, '').match(TASK_TERMS) ?? []).map(
        (t) => t.toLowerCase(),
      ),
    ),
  ];
  const size = Math.min(2000, Math.max(1, Math.floor((limit - 160) / 4)));
  const chunks = Array.from(
    { length: Math.ceil(text.length / size) },
    (_, i) => {
      const value = text.slice(i * size, (i + 1) * size);
      return {
        i,
        value,
        score: terms.reduce(
          (n, term) => n + value.toLowerCase().split(term).length - 1,
          0,
        ),
      };
    },
  );
  // 首尾保留导航和覆盖线索，其他片段优先选择任务相关内容，并按原文顺序返回。
  const selected = new Set([0, chunks.length - 1]);
  const render = () =>
    [...selected]
      .sort((a, b) => a - b)
      .map((i) => `[原文字符 ${i * size} 起]\n${chunks[i]!.value}`)
      .join('\n…中间内容可能省略…\n');
  for (const c of [...chunks].sort((a, b) => b.score - a.score || a.i - b.i)) {
    if (selected.has(c.i)) continue;
    selected.add(c.i);
    if (render().length > limit) selected.delete(c.i);
  }
  // 不可最后机械 slice，否则标注开销可能再次切掉已选中的页尾。
  const excerpt = render();
  if (excerpt.length <= limit) return excerpt;
  const edge = Math.max(0, Math.floor((limit - 1) / 2));
  return `${text.slice(0, edge)}…${edge ? text.slice(-edge) : ''}`;
}

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
      .update(
        JSON.stringify([page.url, text, page.targets.map(targetState).sort()]),
      )
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
    if (actions <= 3) return '动作预算即将耗尽，请整理已有证据并给出保守结论';
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
