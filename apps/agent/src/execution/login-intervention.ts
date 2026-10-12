import type { AgentDecision, VerificationTask } from '@proofrun/contracts';
import type { Observation } from '../evidence/observation.js';

/** 排除访客、退出和登录页验收场景；它们不应被强制变成已登录用户。 */
const GUEST =
  /未登录|不登录|无需登录|退出登录|清除登录|访客|logged[ -]?out|without (?:logging|signing) in|guest|sign out|log out/i;
/** 仅把明确的登录操作或已登录前置条件识别为登录需求，单独“登录按钮”不算。 */
const LOGIN_REQUIRED =
  /登录后|已登录|完成登录|账号.{0,40}登录|账户.{0,40}登录|登录.{0,20}(?:账号|账户)|(?:log|sign)\s*in\b|logged[ -]?in|authenticate/i;
/** 英文登录界面验收也应保留未登录页面，不能因为出现 sign in 就自动接管。 */
const LOGIN_UI_ONLY =
  /(?:inspect|check|verify|test)\s+(?:the\s+)?(?:login|log[- ]?in|sign[- ]?in)\s+(?:page|form|button)(?:\s|$)/i;
/** 只检查 URL 路径中的完整登录段，避免将 redirect 查询参数误当当前登录页。 */
const LOGIN_PATH = /(?:^|\/)(?:login|log-in|signin|sign-in)(?:\/|$)/i;
/** 登录控件与挑战控件需要组合证据，普通导航中的“登录”链接不能触发。 */
const PASSWORD = /密码|password/i;
const LOGIN_BUTTON = /登录|log\s*in|sign\s*in/i;
const CHALLENGE =
  /captcha|turnstile|human verification|security challenge|人机验证/i;
/** 仅用于模型已声明受阻后的兼容判断，不把退出按钮或普通正文当成登录入口。 */
const LOGIN_ENTRY = /^(?:登录|登入|立即登录|log\s*in|sign\s*in)$/i;

/** 访客与业务清理不能通过模型决定升级为登录流程。 */
function permitsLoginRecovery(
  task: VerificationTask,
  stepIndex: number,
): boolean {
  const step = task.steps?.[stepIndex];
  const requirement = step
    ? [step.description, ...step.policy].join('\n')
    : task.objective;
  return (
    task.sessionPlan?.mode !== 'guest' &&
    task.purpose !== 'cleanup' &&
    !task.cleanupStepIds?.includes(step?.stepId ?? '') &&
    !GUEST.test(requirement) &&
    !LOGIN_UI_ONLY.test(requirement)
  );
}

/** 先按结构化原因交接；旧模型仅在任务明确要求登录且页面确有入口时获得一次兜底。 */
export function blockedLoginIntervention(
  task: VerificationTask,
  observation: Observation,
  stepIndex: number,
  decision: Extract<AgentDecision, { type: 'verification.block' }>,
): boolean {
  if (!permitsLoginRecovery(task, stepIndex)) return false;
  if (decision.reasonCode) return decision.reasonCode !== 'OTHER';
  return (
    requiresLogin(task, stepIndex) &&
    observation.targets.some(
      (target) =>
        target.visible !== false &&
        target.ariaHidden !== true &&
        ['button', 'link'].includes(target.role) &&
        LOGIN_ENTRY.test(target.name.trim()),
    )
  );
}

/** 根据当前步骤要求和真实可见控件识别登录阻塞，不从模型自由文本推断权限。 */
export function needsLoginIntervention(
  task: VerificationTask,
  observation: Observation,
  stepIndex: number,
): boolean {
  if (!requiresLogin(task, stepIndex)) return false;
  const visible = observation.targets.filter(
    (target) => target.visible !== false && target.ariaHidden !== true,
  );
  const password = visible.some(
    (t) => t.role === 'textbox' && PASSWORD.test(t.name),
  );
  const loginButton = visible.some(
    (t) => t.role === 'button' && LOGIN_BUTTON.test(t.name),
  );
  const challenge = visible.some(
    (t) => t.role === 'iframe' && CHALLENGE.test(t.name),
  );
  let loginPage = false;
  try {
    loginPage = LOGIN_PATH.test(new URL(observation.url).pathname);
  } catch {
    /* 非网页观察不触发登录恢复。 */
  }
  return (password && loginButton) || (loginPage && challenge);
}

/** 登录恢复只依赖步骤前置条件，不要求介入时恰好位于登录表单。 */
export function requiresLogin(
  task: VerificationTask,
  stepIndex: number,
): boolean {
  const step = task.steps?.[stepIndex];
  const requirement = step
    ? [step.description, ...step.policy].join('\n')
    : task.objective;
  if (
    !permitsLoginRecovery(task, stepIndex) ||
    !LOGIN_REQUIRED.test(requirement)
  )
    return false;
  return true;
}
