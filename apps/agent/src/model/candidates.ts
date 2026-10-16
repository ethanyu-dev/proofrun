import type { ObservedTarget } from '../evidence/observation.js';

/** 旧节点只有语义角色时的兼容集合；普通 element 不获得隐式点击权限。 */
const CLICK_ROLES = new Set([
  'button',
  'link',
  'checkbox',
  'radio',
  'switch',
  'tab',
  'menuitem',
  'menuitemradio',
  'menuitemcheckbox',
  'option',
  'gridcell',
  'combobox',
  'treeitem',
]);
const FILL_ROLES = new Set(['textbox', 'searchbox', 'spinbutton']);
/** 中文短语按相邻字符匹配，不再只识别英文业务词。 */
const WORDS = /[a-z][a-z0-9.-]{2,}|[\p{Script=Han}]{2,}/gu;

/** 一个候选绑定一个允许的操作；动作上限与元素上限分开计数。 */
export interface Candidate {
  /** 能由已有封闭浏览器协议表达的操作，不允许模型创造新动作。 */
  operation:
    | 'CLICK'
    | 'TYPE_TEXT'
    | 'SELECT'
    | 'SCROLL_DOWN'
    | 'SCROLL_UP'
    | 'SCROLL_LEFT'
    | 'SCROLL_RIGHT'
    | 'CHECK'
    | 'UNCHECK'
    | 'FRAME'
    | 'HOVER';
  /** 只属于当前观察的目标身份。 */
  target: string;
  /** 原生选项的实际值，不能用模型生成的标签代替。 */
  value?: string;
  /** 有界的目标描述与状态，供候选问题选择。 */
  field: Record<string, unknown>;
}

/** 候选排序在裁剪前完成，变化控件、活动弹层和任务相关控件依次优先。 */
export function candidates(
  targets: ObservedTarget[],
  objective: string,
  focus?: { scope?: string; terms?: string[] },
  expanded = false,
): Candidate[] {
  const words =
    [objective, ...(focus?.terms ?? [])].join(' ').toLowerCase().match(WORDS) ??
    [];
  const terms = [
    ...new Set(
      words.flatMap((w) =>
        /\p{Script=Han}/u.test(w)
          ? Array.from({ length: w.length - 1 }, (_, i) => w.slice(i, i + 2))
          : [w],
      ),
    ),
  ];
  const relevance = (name: string) =>
    terms.reduce((n, term) => n + Number(name.toLowerCase().includes(term)), 0);
  // 区域关联只是排序信号；未知区域、portal、全局导航和退出控件仍保留。
  const scoped = (t: ObservedTarget) =>
    Number(
      !!focus?.scope &&
        !!t.region &&
        [t.region, ...(t.region.ancestors ?? [])]
          .map((r) => `${r.role} ${r.name}`)
          .join(' / ')
          .toLowerCase()
          .includes(focus.scope.toLowerCase()),
    );
  return [...targets]
    .filter((t) => t.visible !== false && t.disabled !== true)
    .sort(
      (a, b) =>
        scoped(b) - scoped(a) ||
        (focus
          ? Number(relevance(b.name) > 0) - Number(relevance(a.name) > 0)
          : 0) ||
        Number(!!b.change) - Number(!!a.change) ||
        Number(!!b.activeRegion) - Number(!!a.activeRegion) ||
        relevance(b.name) - relevance(a.name) ||
        Number(a.role === 'link') - Number(b.role === 'link'),
    )
    .flatMap((t) => {
      const operations =
        t.operations ??
        (FILL_ROLES.has(t.role)
          ? ['fill']
          : CLICK_ROLES.has(t.role)
            ? ['click']
            : []);
      const field = {
        role: t.role,
        region: t.region,
        context: t.context,
        disclosure: t.disclosure,
        frame: t.frame,
        name: t.name,
        value: t.value,
        expanded: t.expanded,
        checked: t.checked,
        selected: t.selected,
        change: t.change,
        activeRegion: t.activeRegion,
        scroll: t.scroll,
        // clip 仍属于目标自己的 frame，不能假装它是主视口的截图坐标。
        position: t.clip
          ? { frame: t.frame, coordinates: 'frame viewport CSS', clip: t.clip }
          : undefined,
      };
      const actions: Candidate[] = [];
      if (operations.includes('fill') && t.role !== 'combobox')
        actions.push({ operation: 'TYPE_TEXT', target: t.target, field });
      if (
        operations.includes('click') &&
        !(
          expanded &&
          operations.includes('check') &&
          [true, false, 'true', 'false'].includes(t.checked as boolean | string)
        )
      )
        actions.push({ operation: 'CLICK', target: t.target, field });
      if (expanded) {
        if (
          operations.includes('check') &&
          (t.checked === false || t.checked === 'false')
        )
          actions.push({ operation: 'CHECK', target: t.target, field });
        if (
          operations.includes('uncheck') &&
          (t.checked === true || t.checked === 'true')
        )
          actions.push({ operation: 'UNCHECK', target: t.target, field });
        if (operations.includes('frame'))
          actions.push({ operation: 'FRAME', target: t.target, field });
        if (operations.includes('hover'))
          actions.push({ operation: 'HOVER', target: t.target, field });
      }
      if (operations.includes('fill') && t.role === 'combobox')
        actions.push({ operation: 'TYPE_TEXT', target: t.target, field });
      if (operations.includes('select') && Array.isArray(t.options)) {
        for (const option of t.options)
          if (
            option &&
            typeof option.value === 'string' &&
            !option.disabled &&
            !option.selected
          )
            actions.push({
              operation: 'SELECT',
              target: t.target,
              value: option.value,
              field: {
                ...field,
                option: option.label,
                optionValue: option.value,
              },
            });
      }
      if (operations.includes('scroll')) {
        if (
          !t.scroll ||
          t.scroll.y + t.scroll.height < t.scroll.scrollHeight - 1
        )
          actions.push({ operation: 'SCROLL_DOWN', target: t.target, field });
        if (!t.scroll || t.scroll.y > 0)
          actions.push({ operation: 'SCROLL_UP', target: t.target, field });
        if (expanded && t.scroll) {
          if (t.scroll.x + t.scroll.width < t.scroll.scrollWidth - 1)
            actions.push({
              operation: 'SCROLL_RIGHT',
              target: t.target,
              field,
            });
          if (t.scroll.x > 0)
            actions.push({ operation: 'SCROLL_LEFT', target: t.target, field });
        }
      }
      return actions;
    });
}

/** 保守预算估计，不声称与供应商分词一致；非 ASCII 留更大余量并记录实际 usage 校准。 */
export function estimatedTokens(value: unknown): number {
  const text = JSON.stringify(value);
  let ascii = 0,
    other = 0;
  for (const character of text)
    character.codePointAt(0)! < 128 ? ascii++ : other++;
  return Math.ceil(ascii / 3 + other * 2);
}
