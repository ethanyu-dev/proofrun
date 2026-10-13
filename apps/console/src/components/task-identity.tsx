import type { TaskDetail } from '@proofrun/contracts';

/** 模式、准备结果、人工处理和账号释放分别展示，不把登录成功解释成验收通过。 */
export function TaskIdentity({ task }: { task: TaskDetail }) {
  const identity = task.identity;
  if (!identity) return null;
  const mode = {
    guest: '访客（独立空白会话）',
    manual: '人工指定',
    identity: '指定测试身份',
    pool: '测试账号池',
  }[identity.mode];
  const source = {
    snapshot: '已保存登录态',
    cookies: 'Cookie 登录',
    password: '账号密码登录',
    none: '未自动登录',
  }[identity.preparation.source];
  const status = {
    NOT_REQUESTED: '尚未自动准备',
    PENDING: '正在准备',
    READY: '身份自动核验通过',
    NEEDS_HUMAN: '需要人工确认',
    ERROR: '自动准备异常',
  }[identity.preparation.status];
  const lease = {
    NOT_REQUIRED: '独立会话',
    WAITING: '等待分配',
    OCCUPIED: '占用中，等待会话清理',
    RELEASED: '已释放',
  }[identity.leaseState];
  const reasons: Record<string, string> = {
    LOGIN_RECIPE_MISSING: '未配置登录配方',
    LOGIN_RECIPE_UNAVAILABLE: '登录配方不可用',
    LOGIN_FORM_MISMATCH: '页面与配置的登录表单不符',
    LOGIN_CHALLENGE_OR_REJECTED: '需要验证码或登录未获确认',
    ENVIRONMENT_NOT_READY: '不符合验证环境',
    IDENTITY_CHECK_UNMET: '页面身份条件不满足',
    IDENTITY_MANUAL_CHECK_REQUIRED: '账号角色仍需人工确认',
    IDENTITY_VERIFIED: '已核验页面身份条件',
  };
  return (
    <section className="panel task-identity" aria-label="测试身份">
      <h2>测试身份</h2>
      <dl className="facts">
        <div>
          <dt>身份</dt>
          <dd>{identity.label ?? mode}</dd>
        </div>
        <div>
          <dt>登录方式</dt>
          <dd>{source}</dd>
        </div>
        <div>
          <dt>自动准备</dt>
          <dd>
            {status}
            {identity.preparation.durationMs !== null
              ? ` · ${(identity.preparation.durationMs / 1000).toFixed(1)} 秒`
              : ''}
          </dd>
        </div>
        <div>
          <dt>账号占用</dt>
          <dd>{lease}</dd>
        </div>
        <div>
          <dt>人工介入</dt>
          <dd>
            {identity.humanRequests} 次，已处理 {identity.humanCompleted} 次
          </dd>
        </div>
      </dl>
      {identity.preparation.reasonCode &&
        identity.preparation.status !== 'READY' && (
          <p>
            {reasons[identity.preparation.reasonCode] ??
              identity.preparation.reasonCode}
          </p>
        )}
    </section>
  );
}
