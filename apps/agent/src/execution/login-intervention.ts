import type { VerificationTask } from '@proofrun/contracts';
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

/** 根据当前步骤要求和真实可见控件识别登录阻塞，不从模型自由文本推断权限。 */
export function needsLoginIntervention(
  task: VerificationTask,
  observation: Observation,
  stepIndex: number,
): boolean {
  const step = task.steps?.[stepIndex];
  const requirement = step
    ? [step.description, ...step.policy].join('\n')
    : task.objective;
  if (
    task.purpose === 'cleanup' ||
    GUEST.test(requirement) ||
    LOGIN_UI_ONLY.test(requirement) ||
    !LOGIN_REQUIRED.test(requirement)
  )
    return false;
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
