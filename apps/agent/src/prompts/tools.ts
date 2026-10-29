import { BROWSER_ACTION_PROMPTS } from './browser-actions.js';
import type { DecisionTool } from '../model/tools.js';

/** 通用用途随工具注册；子动作的详细规则在最终能力收窄后追加。 */
const TOOL_DESCRIPTIONS: Record<string, string> = {
  'browser.observe':
    '只读观察当前页面；动作后程序已经自动观察，不重复 observe。',
  'browser.act': `执行一个受限动作。
一次回复只能调用一次本工具，并且不能同时返回其他工具调用；填写多个字段也必须拆到不同轮次。
只使用当前 page.targets 的 target 和 operations；历史目标不能重放。
可用 progress 先保存动作前的事实，再执行动作。
操作后程序自动观察，不重复 observe。`,
  'browser.wait':
    '有界等待明确的选择器和文本条件；未命中不证明业务失败，不得重放此前提交。',
  'browser.cookies.clear':
    '仅在清理阶段删除任务站点授权名称的 Cookie，程序校验清理回执；不返回 Cookie 值。',
  'verification.record': `持久化新增 progress，不结束步骤。
各类进度使用各自的原始稳定身份，不能互相替代；只提交本轮 schema 开放的字段。
record 必须带新增进度，无变化反复登记不能获得新预算。`,
  'verification.finish':
    '声明当前步骤已完成，补交 progress 和执行证据。setup 仍须通过程序条件检查，缺少证据不能完成。',
  'verification.block':
    '保存已有 progress 并说明具体缺失前提或证据；不把阻塞写成产品验收失败。',
  'verification.intervene':
    '在任务授权范围内请求人工并列出具体待办；人工确认只支持指定前置条件，不能代替业务验收。',
};

/** 与实际发给模型的 action 枚举一致，尤其不能为无截图请求注入视觉点击说明。 */
export function toolDescription(tool: DecisionTool): string {
  const base = TOOL_DESCRIPTIONS[tool.type] ?? tool.description;
  if (tool.type !== 'browser.act') return base;
  const parameters = tool.parameters as {
    properties: { action: { enum: string[] } };
  };
  return [
    base,
    ...parameters.properties.action.enum.map(
      (action) => BROWSER_ACTION_PROMPTS[action],
    ),
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** 附件标识与观察标识分开，避免模型将页面观察编号误当证据。 */
export const EVIDENCE_REFS_DESCRIPTION =
  '只复制列出的附件 ID；observationId 不是证据，不得改写或猜测 UUID。';
