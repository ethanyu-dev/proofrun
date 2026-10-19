import {
  caseCard,
  CARD_TITLE,
  excerpt,
  STATES,
  TIME_FORMAT,
  VERDICTS,
  type CaseEvent,
  type CaseView,
} from './card.js';
import type { RequestView } from './request-source.js';

/** 仅展开有限成员，避免超过飞书卡片体积限制；完整列表通过请求入口查看。 */
const MAX_CASES = 10;

/** 失败优先、缺报告保持证据不足，与请求汇总的保守口径一致。 */
function verdict(view: CaseView): string | null {
  if (!view.terminal) return null;
  if (view.arms.some((arm) => arm.verdict === 'FAILED')) return 'FAILED';
  return view.arms.length && view.arms.every((arm) => arm.verdict === 'PASSED')
    ? 'PASSED'
    : 'INCONCLUSIVE';
}

/** 主卡片仅列 case 状态和提交时间，报告仅列最终结论；HITL 保持 case 专属入口。 */
export function requestCard(
  event: CaseEvent,
  view: RequestView,
  origin: string,
  secret: string,
) {
  if (event.kind === 'HITL') {
    const member = view.cases.find((item) =>
      item.arms.some((arm) => arm.taskId === event.taskId),
    );
    if (!member) throw new Error('人工处理通知对应的 case 不在请求中');
    return caseCard(event, member, origin, secret);
  }
  const text = (content: string) => ({ tag: 'plain_text', content });
  const div = (content: string) => ({ tag: 'div', text: text(content) });
  const report = event.kind === 'COMPLETED';
  const result = verdict(view);
  return {
    config: {
      wide_screen_mode: true,
      enable_forward: false,
      update_multi: true,
    },
    header: {
      template:
        view.state === 'WAITING_HUMAN'
          ? 'orange'
          : view.terminal
            ? result === 'PASSED'
              ? 'green'
              : 'grey'
            : 'blue',
      title: text(
        `${CARD_TITLE} · ${report ? VERDICTS[result!] : (STATES[view.state] ?? view.state)}`,
      ),
    },
    elements: [
      ...view.cases
        .slice(0, MAX_CASES)
        .map((item) =>
          div(
            `Case：${excerpt(item.caseId, 128)}\n${excerpt(item.objective, 160)}\n${report ? `最终结论：${verdict(item) ? VERDICTS[verdict(item)!] : '尚无结论'}` : `验证状态：${STATES[item.state] ?? item.state}\n提交时间：${TIME_FORMAT.format(new Date(event.at))}（北京时间）`}`,
          ),
        ),
      ...(view.cases.length > MAX_CASES
        ? [
            div(
              `其余 ${view.cases.length - MAX_CASES} 个 Case 请查看完整请求。`,
            ),
          ]
        : []),
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            type: 'default',
            text: text(report ? '查看汇总报告' : '查看请求'),
            url: `${origin}/#/${report ? 'request-reports' : 'requests'}/${encodeURIComponent(view.requestId)}`,
          },
        ],
      },
    ],
  };
}
