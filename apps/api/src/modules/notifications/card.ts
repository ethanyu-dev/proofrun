import { interventionToken } from '../scheduling/hitl-token.js';

/** 卡片仅展示摘要，完整内容以 Console 和处理页为准。 */
const TEXT_LIMIT = 300;
const ITEM_LIMIT = 120;
const MAX_ITEMS = 10;
/** 所有通知统一使用业务名称，避免将内部项目名作为卡片标题。 */
export const CARD_TITLE = '自动化测试';
/** 删除不可见控制符以限制 JSON 转义膨胀，保留正常换行和制表。 */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
/** 固定北京时间，不受 API 容器时区影响。 */
export const TIME_FORMAT = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  dateStyle: 'short',
  timeStyle: 'medium',
  hourCycle: 'h23',
});
/** 事件文案与当前状态分离；旧卡片保留原事件作为过程记录。 */
const EVENTS = {
  SUBMITTED: 'Case 已提交',
  HITL: '进入人工处理',
  RESUMED: '已恢复执行',
  COMPLETED: 'Case 执行已结束',
};
/** 执行结束不等于验收通过，分别展示生命周期与结论。 */
export const STATES: Record<string, string> = {
  QUEUED: '排队中',
  RUNNING: '执行中',
  WAITING_HUMAN: '等待人工处理',
  COMPLETED: '执行完成',
  CANCELLED: '已取消',
  TIMED_OUT: '已超时',
  ERROR: '执行错误',
  ENDED: '执行已结束',
};
export const VERDICTS: Record<string, string> = {
  PASSED: '验收通过',
  FAILED: '验收失败',
  INCONCLUSIVE: '证据不足',
  SKIPPED: '未验收',
};

/** 不可变通知事件；不含凭据，身份关联用于判断历史人工请求是否结束。 */
export interface CaseEvent {
  /** 同一轮次内的稳定事件身份。 */
  key: string;
  /** 提交、首次人工处理和完成产生新消息；保留恢复类型以读取旧记录。 */
  kind: keyof typeof EVENTS;
  /** 来自持久任务或控制权记录的原始时间。 */
  at: string;
  /** 人工事件对应的任务，用于定位 case；提交和整例完成可为空。 */
  taskId: string | null;
  /** 人工请求的执行身份；不绑定可轮换的链接 ID。 */
  executionId: string | null;
  /** 首次人工请求的控制代次，后续代次复用卡片。 */
  revision: number | null;
  /** 原事件原因，当前状态变化时保留。 */
  reason: string | null;
}

/** 单组当前可展示事实，仅取必要字段，禁止把任务或身份定义整体写入消息表。 */
export interface CaseArmView {
  /** Console 任务和报告的真实身份。 */
  taskId: string;
  /** 历史快照可能保留组名；渲染时统一使用任务身份。 */
  label: string;
  /** 运行状态包含等待人工的投影，不改变数据库生命周期。 */
  state: string;
  /** 验收结论独立于执行状态；尚未执行验收时为空。 */
  verdict: string | null;
  /** 人工无法处理或错误原因；原文仅作纯文本展示。 */
  detail: string | null;
  /** 有真实报告时才显示报告入口。 */
  hasReport: boolean;
  /** 当前请求身份与可用入口；过期或失联时不提供操作入口。 */
  human: null | {
    /** 可轮换的处理链接身份，真正的 token 在发送时派生。 */
    id: string;
    /** 执行与代次用于关联历史事件。 */
    executionId: string;
    revision: number;
    /** 当前请求理由与待办，完整列表仍在处理页。 */
    reason: string;
    items: string[];
    /** 链接、人工等待、清理截止三者的较早时间。 */
    deadline: string;
  };
}

/** 可持久化的初次发送快照，不存储访问令牌或 HITL token。 */
export interface CaseView {
  /** 上游 Case 身份，内部任务回退为轮次身份。 */
  caseId: string;
  /** Console 列表中的验证目标。 */
  objective: string;
  /** 聚合全部成员当前状态，只有全部结束才为终态。 */
  state: string;
  /** 必需成员均存在且均结束时才允许发送完成事件。 */
  terminal: boolean;
  /** 固定顺序展示各组，不能合并相互矛盾的验收结论。 */
  arms: CaseArmView[];
  /** 保留旧快照的已结束请求身份；卡片现在按 case 当前状态判断是否结束。 */
  endedRequests: string[];
}

/** 按码点截断，不切断表情，也不把用户文案作为 Markdown 或 @ 标签解析。 */
export function excerpt(value: string, limit = TEXT_LIMIT): string {
  const clean = value.replace(CONTROL_CHARACTERS, '');
  const chars = Array.from(clean);
  return chars.length > limit ? `${chars.slice(0, limit).join('')}…` : clean;
}

/** 所有历史卡片展示同一当前视图，事件身份和发生时间仍保持不变。 */
export function caseCard(
  event: CaseEvent,
  view: CaseView,
  origin: string,
  secret: string,
) {
  view = {
    ...view,
    arms: view.arms.map((arm) => ({ ...arm, label: `任务 ${arm.taskId}` })),
  };
  const text = (content: string) => ({ tag: 'plain_text', content });
  const div = (content: string) => ({ tag: 'div', text: text(content) });
  const buttons = view.arms.flatMap((arm) => [
    ...(arm.human
      ? [
          {
            tag: 'button',
            type: 'primary',
            text: text(
              view.arms.length === 1 ? '立即处理' : `处理${arm.label}`,
            ),
            url: `${origin}/#/hitl/${arm.human.id}/${interventionToken(secret, arm.human.id)}`,
          },
        ]
      : []),
    {
      tag: 'button',
      type: 'default',
      text: text(
        `${view.arms.length > 1 ? arm.label + ' · ' : ''}${arm.hasReport ? '查看报告' : '查看任务'}`,
      ),
      url: `${origin}/#/${arm.hasReport ? 'reports' : 'tasks'}/${encodeURIComponent(arm.taskId)}`,
    },
  ]);
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
            ? view.arms.every(
                (arm) => arm.state === 'COMPLETED' && arm.verdict === 'PASSED',
              )
              ? 'green'
              : 'grey'
            : 'blue',
      title: text(`${CARD_TITLE} · ${STATES[view.state] ?? view.state}`),
    },
    elements: [
      div(excerpt(view.objective)),
      // HITL 上半部只保留验证内容及首次介入时间，下半部继续同步当前处理事实。
      ...(event.kind === 'HITL'
        ? [
            div(
              `发生时间：${TIME_FORMAT.format(new Date(event.at))}（北京时间）`,
            ),
          ]
        : [
            div(`Case：${excerpt(view.caseId, 128)}`),
            div(
              `事件：${EVENTS[event.kind]}\n发生时间：${TIME_FORMAT.format(new Date(event.at))}（北京时间）${event.reason ? '\n事件原因：' + excerpt(event.reason) : ''}`,
            ),
          ]),
      { tag: 'hr' },
      ...view.arms.flatMap((arm) => [
        div(
          `${view.arms.length > 1 ? arm.label + ' · ' : ''}${STATES[arm.state] ?? arm.state}\n验收结论：${arm.verdict ? (VERDICTS[arm.verdict] ?? arm.verdict) : '尚无结论'}${arm.detail ? '\n' + excerpt(arm.detail) : ''}`,
        ),
        ...(arm.human
          ? [
              div(
                `介入原因：${excerpt(arm.human.reason)}\n待办事项\n${arm.human.items
                  .slice(0, MAX_ITEMS)
                  .map((item, i) => `${i + 1}. ${excerpt(item, ITEM_LIMIT)}`)
                  .join(
                    '\n',
                  )}\n处理截止：${TIME_FORMAT.format(new Date(arm.human.deadline))}（北京时间）`,
              ),
            ]
          : []),
      ]),
      { tag: 'action', actions: buttons },
      {
        tag: 'note',
        elements: [
          text(
            '事件记录保留原始时间，当前状态随任务同步。处理入口仅供本群协作人员使用，最终状态以 Console 为准。',
          ),
        ],
      },
    ],
  };
}
