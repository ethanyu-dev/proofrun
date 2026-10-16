import { createHash } from 'node:crypto';
import type { Observation, ObservedTarget } from '../evidence/observation.js';
import type { WorkflowUpdate } from './workflow.js';
import { AgentFault } from '../http.js';

/** 登录秘密由节点管理，不发布常见密码字段的计划填写绑定。 */
const SECRET_FIELD = /password|密码|口令/i;
/** 单计划可携带的非秘密测试输入上限。 */
export const PLAN_INPUT_LIMIT = 16;

/** 填写值只引用当前观察中唯一的语义字段，不持久化可操作 target。 */
export interface PlanInput {
  /** 执行器生成的语义身份，页面、frame 文档或字段含义变化后自然失效。 */
  key: string;
  /** 来自任务或任务允许构造的测试值；不用于身份库秘密。 */
  value: string;
}

/** 不包含临时 target 和当前值，填写后仍可匹配；相同语义的多字段明确视为歧义。 */
function fieldKey(page: Observation, target: ObservedTarget) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        page.url,
        target.frame
          ? (page.documents?.find((d) => d.frameId === target.frame)?.url ??
            target.frame)
          : 'main',
        target.role,
        target.name,
        target.tag,
        target.region,
        target.context?.heading,
      ]),
    )
    .digest('hex');
}

/** 只返回当前观察可填写且语义唯一的字段；这些键本身没有浏览器执行权限。 */
export function planFields(page: Observation) {
  const fields = page.targets
    .filter(
      (t) =>
        t.visible !== false &&
        !t.disabled &&
        !SECRET_FIELD.test(t.name) &&
        (t.operations?.includes('fill') ??
          ['textbox', 'searchbox', 'spinbutton'].includes(t.role)),
    )
    .map((t) => ({
      key: fieldKey(page, t),
      target: t.target,
      name: t.name,
      role: t.role,
    }));
  const counts = new Map<string, number>();
  for (const f of fields) counts.set(f.key, (counts.get(f.key) ?? 0) + 1);
  return fields.filter((f) => counts.get(f.key) === 1);
}

/** 计划只绑定本轮真实字段；校验失败不保存计划，也不派发首个动作。 */
export function validatePlanInputs(
  plan: WorkflowUpdate['recovery'],
  page: Observation,
) {
  if (plan && (!plan.allowedActions?.length || plan.maxActions > 6))
    throw new AgentFault(
      'INVALID_MODEL_DECISION',
      '局部计划必须声明 allowedActions，且最多6次动作',
    );
  if (!plan?.inputs) return;
  const fields = new Set(planFields(page).map((f) => f.key));
  if (
    !Array.isArray(plan.inputs) ||
    plan.inputs.some((input) => !input || !fields.has(input.key))
  )
    throw new AgentFault(
      'INVALID_MODEL_DECISION',
      'plan.inputs 只能绑定本轮 inputFields 中唯一且可填写的字段',
    );
}
