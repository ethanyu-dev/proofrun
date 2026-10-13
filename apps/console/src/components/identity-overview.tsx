import type { IdentityCatalog, IdentityMetrics } from '../identity-config';

/** 只展示公开元数据，外部目录必须在提供方维护后刷新。 */
export function IdentityCatalogSummary({
  catalog,
}: {
  catalog: IdentityCatalog;
}) {
  return (
    <div className="identity-catalog-summary">
      <h3>身份 · {catalog.identities.length}</h3>
      {!catalog.identities.length ? (
        <p className="muted">目录中没有身份。</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>身份 / 账号键</th>
                <th>适用站点</th>
                <th>登录配方</th>
                <th>核验条件</th>
                <th>并发</th>
              </tr>
            </thead>
            <tbody>
              {catalog.identities.map((identity) => (
                <tr key={identity.id}>
                  <td>
                    <strong>{identity.label}</strong>
                    <br />
                    <span className="mono muted">
                      {identity.id} / {identity.accountKey}
                    </span>
                  </td>
                  <td>{identity.origins.join('、')}</td>
                  <td>{identity.loginRef ?? '登录快照 / 人工登录'}</td>
                  <td>
                    {identity.checks.map((check) => (
                      <p key={check.id}>
                        {check.description} ·{' '}
                        {check.method === 'manual'
                          ? '人工确认'
                          : check.method === 'text'
                            ? '包含文本'
                            : '不含文本'}
                        {check.value ? `：${check.value}` : ''}
                      </p>
                    ))}
                  </td>
                  <td>{identity.maxConcurrent}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h3>账号池 · {catalog.pools.length}</h3>
      {!catalog.pools.length ? (
        <p className="muted">目录中没有账号池。</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>账号池</th>
                <th>身份成员</th>
              </tr>
            </thead>
            <tbody>
              {catalog.pools.map((pool) => (
                <tr key={pool.id}>
                  <td>{pool.id}</td>
                  <td>{pool.identityRefs.join('、')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h3>站点规则 · {catalog.sites.length}</h3>
      {!catalog.sites.length ? (
        <p className="muted">目录中没有自动匹配规则。</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>规则</th>
                <th>域名 / 路径</th>
                <th>环境 / 节点池</th>
                <th>身份 / 账号池</th>
              </tr>
            </thead>
            <tbody>
              {catalog.sites.map((site) => (
                <tr key={site.id}>
                  <td>{site.id}</td>
                  <td>
                    {site.hostname}
                    {site.pathPrefix ?? '/'}
                  </td>
                  <td>
                    {site.environment} / {site.nodePool}
                  </td>
                  <td>
                    {site.identityRef
                      ? `身份 · ${site.identityRef}`
                      : `账号池 · ${site.poolRef}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** 稳定原因码映射为管理员可理解的短文本，未知码保留方便诊断。 */
const REASONS: Record<string, string> = {
  GENERAL: '其他人工介入',
  LOGIN_REQUIRED: '需要登录',
  ENVIRONMENT_NOT_READY: '不符合验证环境',
  IDENTITY_CHECK_UNMET: '身份条件未满足',
  LOGIN_RECIPE_MISSING: '缺少登录配方',
  LOGIN_RECIPE_UNAVAILABLE: '登录配方不可用',
  LOGIN_FORM_MISMATCH: '登录表单不匹配',
  LOGIN_CHALLENGE_OR_REJECTED: '验证码或登录未获确认',
};
const SOURCES: Record<string, string> = {
  snapshot: '已保存登录态',
  cookies: 'Cookie',
  password: '账号密码',
  none: '未自动登录',
};
const STATUSES: Record<string, string> = {
  READY: '核验通过',
  NEEDS_HUMAN: '需要人工',
  ERROR: '准备异常',
  PENDING: '准备中',
};

/** 有占用的账号才返回实时容量；空列表只表示当前没有账号占用。 */
export function IdentityUsage({ metrics }: { metrics: IdentityMetrics }) {
  return (
    <section
      className="identity-section identity-usage"
      aria-labelledby="identity-usage-heading"
    >
      <h2 id="identity-usage-heading">使用情况</h2>
      <p className="muted">
        最近 {metrics.windowDays}{' '}
        天。自动核验通过表示登录身份已确认，不代表业务验收通过。
      </p>
      <dl className="facts">
        <div>
          <dt>完成登录准备</dt>
          <dd>{metrics.completedPreparations} 次</dd>
        </div>
        <div>
          <dt>自动核验通过</dt>
          <dd>
            {metrics.automaticReadyRate === null
              ? '暂无数据'
              : `${(metrics.automaticReadyRate * 100).toFixed(1)}% · ${metrics.automaticReady} 次`}
          </dd>
        </div>
        <div>
          <dt>等待账号</dt>
          <dd>{metrics.waitingForIdentity} 个任务</dd>
        </div>
      </dl>
      <h3>当前账号占用</h3>
      {!metrics.accounts.length ? (
        <p className="muted">当前没有账号占用。</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>账号键</th>
                <th>占用 / 并发上限</th>
              </tr>
            </thead>
            <tbody>
              {metrics.accounts.map((account) => (
                <tr key={account.accountKey}>
                  <td>{account.accountKey}</td>
                  <td>
                    {account.occupied} / {account.capacity}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!!metrics.attempts.length && (
        <>
          <h3>登录准备结果</h3>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>登录方式</th>
                  <th>结果</th>
                  <th>次数</th>
                  <th>平均耗时</th>
                </tr>
              </thead>
              <tbody>
                {metrics.attempts.map((item) => (
                  <tr key={`${item.source}-${item.status}`}>
                    <td>{SOURCES[item.source] ?? item.source}</td>
                    <td>{STATUSES[item.status] ?? item.status}</td>
                    <td>{item.count}</td>
                    <td>
                      {item.averageMs === null
                        ? '—'
                        : `${(item.averageMs / 1000).toFixed(1)} 秒`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {!!metrics.hitl.length && (
        <>
          <h3>人工介入原因</h3>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>原因</th>
                  <th>请求次数</th>
                  <th>已处理</th>
                </tr>
              </thead>
              <tbody>
                {metrics.hitl.map((item) => (
                  <tr key={item.reason}>
                    <td>{REASONS[item.reason] ?? item.reason}</td>
                    <td>{item.count}</td>
                    <td>{item.completed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
