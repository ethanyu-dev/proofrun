import type { ReactNode } from 'react';
import type { IdentityCatalog, TestIdentity } from '../identity-config';

/** 新条目的本地标识不依赖数组长度，删除后再添加也不会产生重复 ID。 */
const freshId = (prefix: string) =>
  `${prefix}-${crypto.randomUUID().slice(0, 8)}`;

/** 统一表单标签和可访问关联；children 不拼接 HTML。 */
export function IdentityField({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="identity-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

/** 身份、账号池和站点规则一次提交，避免保存到互相悬空的中间状态。 */
export function IdentityCatalogEditor({
  catalog,
  change,
}: {
  catalog: IdentityCatalog;
  change: (value: IdentityCatalog) => void;
}) {
  const patchIdentity = (index: number, patch: Partial<TestIdentity>) =>
    change({
      ...catalog,
      identities: catalog.identities.map((item, i) =>
        i === index ? { ...item, ...patch } : item,
      ),
    });
  return (
    <div className="identity-editor">
      <section aria-labelledby="identity-accounts-heading">
        <div className="section-heading">
          <div>
            <h2 id="identity-accounts-heading">测试身份</h2>
            <p className="muted">
              同一账号的不同身份使用相同账号键。登录配方引用由 Browser Node
              读取，凭据保留在节点或外部凭据服务。
            </p>
          </div>
          <button
            type="button"
            className="button button-secondary"
            disabled={catalog.identities.length >= 256}
            onClick={() =>
              change({
                ...catalog,
                identities: [
                  ...catalog.identities,
                  {
                    id: freshId('identity'),
                    label: '',
                    accountKey: '',
                    origins: [],
                    maxConcurrent: 1,
                    checks: [
                      {
                        id: 'account',
                        description: '确认账号及角色符合测试要求',
                        method: 'manual',
                      },
                    ],
                  },
                ],
              })
            }
          >
            添加身份
          </button>
        </div>
        {!catalog.identities.length && (
          <p className="identity-empty muted">
            尚未配置身份。添加后可将它加入账号池或站点规则。
          </p>
        )}
        {catalog.identities.map((identity, index) => (
          <fieldset className="identity-entry" key={index}>
            <legend>{identity.label || `身份 ${index + 1}`}</legend>
            <div className="identity-form-grid">
              <IdentityField label="身份 ID">
                <input
                  required
                  pattern="[A-Za-z0-9_-]{1,80}"
                  value={identity.id}
                  onChange={(e) => patchIdentity(index, { id: e.target.value })}
                />
              </IdentityField>
              <IdentityField label="显示名称">
                <input
                  required
                  maxLength={160}
                  value={identity.label}
                  onChange={(e) =>
                    patchIdentity(index, { label: e.target.value })
                  }
                />
              </IdentityField>
              <IdentityField label="账号键（标识真实账号）">
                <input
                  required
                  maxLength={80}
                  pattern="[A-Za-z0-9_-]{1,80}"
                  value={identity.accountKey}
                  onChange={(e) =>
                    patchIdentity(index, { accountKey: e.target.value })
                  }
                />
              </IdentityField>
              <IdentityField label="最大并发">
                <input
                  type="number"
                  min={1}
                  max={32}
                  required
                  value={identity.maxConcurrent}
                  onChange={(e) =>
                    patchIdentity(index, {
                      maxConcurrent: Number(e.target.value),
                    })
                  }
                />
              </IdentityField>
              <IdentityField label="适用站点源（每行一个，包含协议，不含路径）">
                <textarea
                  required
                  rows={2}
                  value={identity.origins.join('\n')}
                  onChange={(e) =>
                    patchIdentity(index, {
                      origins: e.target.value.split('\n'),
                    })
                  }
                />
              </IdentityField>
              <IdentityField label="登录配方引用（可选）">
                <input
                  maxLength={80}
                  value={identity.loginRef ?? ''}
                  onChange={(e) => {
                    const next = { ...identity };
                    if (e.target.value) next.loginRef = e.target.value;
                    else delete next.loginRef;
                    change({
                      ...catalog,
                      identities: catalog.identities.map((item, i) =>
                        i === index ? next : item,
                      ),
                    });
                  }}
                />
              </IdentityField>
            </div>
            <div className="identity-checks">
              <h3>身份核验条件</h3>
              <p className="muted note">
                自动核验至少需要一个能唯一识别账号的正向文本条件；无法从页面确认的角色选择人工确认。
              </p>
              {identity.checks.map((check, ci) => (
                <div className="identity-check-row" key={ci}>
                  <IdentityField label="条件 ID">
                    <input
                      required
                      value={check.id}
                      onChange={(e) =>
                        patchIdentity(index, {
                          checks: identity.checks.map((v, i) =>
                            i === ci ? { ...v, id: e.target.value } : v,
                          ),
                        })
                      }
                    />
                  </IdentityField>
                  <IdentityField label="条件说明">
                    <input
                      required
                      maxLength={500}
                      value={check.description}
                      onChange={(e) =>
                        patchIdentity(index, {
                          checks: identity.checks.map((v, i) =>
                            i === ci
                              ? { ...v, description: e.target.value }
                              : v,
                          ),
                        })
                      }
                    />
                  </IdentityField>
                  <IdentityField label="核验方式">
                    <select
                      value={check.method}
                      onChange={(e) =>
                        patchIdentity(index, {
                          checks: identity.checks.map((v, i) =>
                            i === ci
                              ? {
                                  id: v.id,
                                  description: v.description,
                                  method: e.target.value as typeof v.method,
                                  ...(e.target.value === 'manual'
                                    ? {}
                                    : { value: v.value ?? '' }),
                                }
                              : v,
                          ),
                        })
                      }
                    >
                      <option value="text">包含文本</option>
                      <option value="absent">不含文本</option>
                      <option value="manual">人工确认</option>
                    </select>
                  </IdentityField>
                  {check.method !== 'manual' && (
                    <IdentityField label="匹配文本">
                      <input
                        required
                        maxLength={2000}
                        value={check.value ?? ''}
                        onChange={(e) =>
                          patchIdentity(index, {
                            checks: identity.checks.map((v, i) =>
                              i === ci ? { ...v, value: e.target.value } : v,
                            ),
                          })
                        }
                      />
                    </IdentityField>
                  )}
                  <button
                    type="button"
                    className="text-button"
                    disabled={identity.checks.length <= 1}
                    aria-label={`删除条件 ${ci + 1}`}
                    onClick={() =>
                      patchIdentity(index, {
                        checks: identity.checks.filter((_, i) => i !== ci),
                      })
                    }
                  >
                    删除
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="text-button"
                disabled={identity.checks.length >= 10}
                onClick={() =>
                  patchIdentity(index, {
                    checks: [
                      ...identity.checks,
                      {
                        id: freshId('check'),
                        description: '',
                        method: 'manual',
                      },
                    ],
                  })
                }
              >
                ＋ 添加核验条件
              </button>
            </div>
            <details>
              <summary>已有登录快照（可选）</summary>
              <div className="identity-form-grid">
                <IdentityField label="节点 ID">
                  <input
                    value={identity.nodeId ?? ''}
                    onChange={(e) => {
                      const next = { ...identity };
                      if (e.target.value) next.nodeId = e.target.value;
                      else delete next.nodeId;
                      change({
                        ...catalog,
                        identities: catalog.identities.map((v, i) =>
                          i === index ? next : v,
                        ),
                      });
                    }}
                  />
                </IdentityField>
                <IdentityField label="快照 ID">
                  <input
                    value={identity.stateId ?? ''}
                    onChange={(e) => {
                      const next = { ...identity };
                      if (e.target.value) next.stateId = e.target.value;
                      else delete next.stateId;
                      change({
                        ...catalog,
                        identities: catalog.identities.map((v, i) =>
                          i === index ? next : v,
                        ),
                      });
                    }}
                  />
                </IdentityField>
              </div>
              <p className="muted note">
                节点 ID 与快照 ID 必须同时填写。省略时使用身份专属登录槽。
              </p>
            </details>
            <button
              type="button"
              className="text-button"
              onClick={() =>
                change({
                  ...catalog,
                  identities: catalog.identities.filter((_, i) => i !== index),
                })
              }
            >
              删除此身份
            </button>
          </fieldset>
        ))}
      </section>
      <section aria-labelledby="identity-pools-heading">
        <div className="section-heading">
          <div>
            <h2 id="identity-pools-heading">账号池</h2>
            <p className="muted">从池中分配可用账号；账号并发默认独占。</p>
          </div>
          <button
            type="button"
            className="button button-secondary"
            disabled={!catalog.identities.length || catalog.pools.length >= 128}
            onClick={() =>
              change({
                ...catalog,
                pools: [
                  ...catalog.pools,
                  { id: freshId('pool'), identityRefs: [] },
                ],
              })
            }
          >
            添加账号池
          </button>
        </div>
        {!catalog.pools.length && (
          <p className="identity-empty muted">
            尚未配置账号池，可直接使用单个身份。
          </p>
        )}
        {catalog.pools.map((pool, index) => (
          <fieldset className="identity-entry" key={index}>
            <legend>账号池 {index + 1}</legend>
            <IdentityField label="账号池 ID">
              <input
                required
                pattern="[A-Za-z0-9_-]{1,80}"
                value={pool.id}
                onChange={(e) =>
                  change({
                    ...catalog,
                    pools: catalog.pools.map((v, i) =>
                      i === index ? { ...v, id: e.target.value } : v,
                    ),
                  })
                }
              />
            </IdentityField>
            <div className="identity-pool-members">
              {catalog.identities.map((identity, ii) => (
                <label className="check-label" key={ii}>
                  <input
                    type="checkbox"
                    checked={pool.identityRefs.includes(identity.id)}
                    onChange={(e) =>
                      change({
                        ...catalog,
                        pools: catalog.pools.map((v, i) =>
                          i === index
                            ? {
                                ...v,
                                identityRefs: e.target.checked
                                  ? [...v.identityRefs, identity.id]
                                  : v.identityRefs.filter(
                                      (id) => id !== identity.id,
                                    ),
                              }
                            : v,
                        ),
                      })
                    }
                  />
                  {identity.label || identity.id}
                </label>
              ))}
            </div>
            {pool.identityRefs.some(
              (id) =>
                !catalog.identities.some((identity) => identity.id === id),
            ) && (
              <p role="alert">
                池内存在已删除或改名的身份，请移除失效引用后重新选择。
                <button
                  type="button"
                  className="text-button"
                  onClick={() =>
                    change({
                      ...catalog,
                      pools: catalog.pools.map((v, i) =>
                        i === index
                          ? {
                              ...v,
                              identityRefs: v.identityRefs.filter((id) =>
                                catalog.identities.some(
                                  (identity) => identity.id === id,
                                ),
                              ),
                            }
                          : v,
                      ),
                    })
                  }
                >
                  移除失效引用
                </button>
              </p>
            )}
            <button
              type="button"
              className="text-button"
              onClick={() =>
                change({
                  ...catalog,
                  pools: catalog.pools.filter((_, i) => i !== index),
                })
              }
            >
              删除此账号池
            </button>
          </fieldset>
        ))}
      </section>
      <section aria-labelledby="identity-sites-heading">
        <div className="section-heading">
          <div>
            <h2 id="identity-sites-heading">站点规则</h2>
            <p className="muted">
              任务选择自动身份时生效。按环境、节点池、域名和路径匹配；精确域名优先。
            </p>
          </div>
          <button
            type="button"
            className="button button-secondary"
            disabled={!catalog.identities.length || catalog.sites.length >= 256}
            onClick={() =>
              change({
                ...catalog,
                sites: [
                  ...catalog.sites,
                  {
                    id: freshId('site'),
                    hostname: '',
                    environment: 'production',
                    nodePool: 'internal',
                    identityRef: catalog.identities[0]!.id,
                  },
                ],
              })
            }
          >
            添加规则
          </button>
        </div>
        {!catalog.sites.length && (
          <p className="identity-empty muted">
            尚未配置规则，任务仍可显式指定身份或账号池。
          </p>
        )}
        {catalog.sites.map((site, index) => {
          const patch = (fields: Partial<typeof site>) =>
            change({
              ...catalog,
              sites: catalog.sites.map((v, i) =>
                i === index ? { ...v, ...fields } : v,
              ),
            });
          const target = site.identityRef
            ? `identity:${site.identityRef}`
            : `pool:${site.poolRef}`;
          const missing = site.identityRef
            ? !catalog.identities.some((v) => v.id === site.identityRef)
            : !catalog.pools.some((v) => v.id === site.poolRef);
          return (
            <fieldset className="identity-entry" key={index}>
              <legend>站点规则 {index + 1}</legend>
              <div className="identity-form-grid">
                <IdentityField label="规则 ID">
                  <input
                    required
                    pattern="[A-Za-z0-9_-]{1,80}"
                    value={site.id}
                    onChange={(e) => patch({ id: e.target.value })}
                  />
                </IdentityField>
                <IdentityField label="域名">
                  <input
                    required
                    placeholder="example.com 或 *.example.com"
                    value={site.hostname}
                    onChange={(e) => patch({ hostname: e.target.value })}
                  />
                </IdentityField>
                <IdentityField label="路径前缀">
                  <input
                    value={site.pathPrefix ?? '/'}
                    onChange={(e) => patch({ pathPrefix: e.target.value })}
                  />
                </IdentityField>
                <IdentityField label="执行环境">
                  <input
                    required
                    value={site.environment}
                    onChange={(e) => patch({ environment: e.target.value })}
                  />
                </IdentityField>
                <IdentityField label="节点池">
                  <input
                    required
                    value={site.nodePool}
                    onChange={(e) => patch({ nodePool: e.target.value })}
                  />
                </IdentityField>
                <IdentityField label="使用身份或账号池">
                  <select
                    required
                    value={target}
                    onChange={(e) => {
                      const [kind, id] = e.target.value.split(':');
                      const next = { ...site };
                      delete next.identityRef;
                      delete next.poolRef;
                      if (kind === 'identity') next.identityRef = id!;
                      else next.poolRef = id!;
                      change({
                        ...catalog,
                        sites: catalog.sites.map((v, i) =>
                          i === index ? next : v,
                        ),
                      });
                    }}
                  >
                    {missing && (
                      <option value={target}>引用已失效，请重新选择</option>
                    )}
                    {catalog.identities.map((identity, i) => (
                      <option key={`i${i}`} value={`identity:${identity.id}`}>
                        身份 · {identity.label || identity.id}
                      </option>
                    ))}
                    {catalog.pools.map((pool, i) => (
                      <option key={`p${i}`} value={`pool:${pool.id}`}>
                        账号池 · {pool.id}
                      </option>
                    ))}
                  </select>
                </IdentityField>
              </div>
              <button
                type="button"
                className="text-button"
                onClick={() =>
                  change({
                    ...catalog,
                    sites: catalog.sites.filter((_, i) => i !== index),
                  })
                }
              >
                删除此规则
              </button>
            </fieldset>
          );
        })}
      </section>
    </div>
  );
}
