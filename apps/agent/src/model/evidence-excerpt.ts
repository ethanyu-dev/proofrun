/** 从任务文字提取检索词，排除 URL，避免整站导航词压过业务主题。 */
const TASK_TERMS = /[\p{L}\p{N}][\p{L}\p{N}._-]{2,}/gu;

/** 长页面按任务相关段落选取；完整当前页仍由执行器提供给文本模型。 */
export function evidenceExcerpt(
  text: string,
  objective: string,
  limit = 16000,
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
