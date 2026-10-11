import type { SessionPlan } from '@proofrun/contracts';

/** 页面只维护身份元数据；密码和 Cookie 不属于此目录。 */
export type TestIdentity = Omit<
  SessionPlan['candidates'][number],
  'origins'
> & {
  /** 编辑时保留空行，提交前再规范化并由服务端校验最多十六个源。 */
  origins: string[];
};
export interface IdentityCatalog {
  identities: TestIdentity[];
  pools: Array<{ id: string; identityRefs: string[] }>;
  sites: Array<{
    id: string;
    hostname: string;
    pathPrefix?: string;
    environment: string;
    nodePool: string;
    identityRef?: string;
    poolRef?: string;
  }>;
}
/** 服务端投影不含令牌或私有文件路径，读取故障不影响配置表单。 */
export interface IdentitySettingsView {
  revision: number;
  mode: 'environment' | 'local' | 'http';
  source: 'local' | 'http';
  url: string | null;
  tokenConfigured: boolean;
  catalog: IdentityCatalog | null;
  updatedAt: string;
}
/** 使用统计来自执行回执，自动核验不等于业务验收通过。 */
export interface IdentityMetrics {
  windowDays: number;
  completedPreparations: number;
  automaticReady: number;
  automaticReadyRate: number | null;
  waitingForIdentity: number;
  accounts: Array<{ accountKey: string; occupied: number; capacity: number }>;
  attempts: Array<{
    source: string;
    status: string;
    count: number;
    averageMs: number | null;
  }>;
  hitl: Array<{ reason: string; count: number; completed: number }>;
}
/** 未配置时显示真正的空目录，不能把连接失败替换成空目录。 */
export const emptyCatalog = (): IdentityCatalog => ({
  identities: [],
  pools: [],
  sites: [],
});

/** 仅外部模式允许提交令牌；空白输入表示保留，地址变更由服务端要求重填。 */
export function identityWrite(
  revision: number,
  mode: IdentitySettingsView['mode'],
  url: string,
  token: string,
  catalog: IdentityCatalog,
) {
  if (mode === 'environment') return { revision, mode };
  if (mode === 'local')
    return {
      revision,
      mode,
      catalog: {
        ...catalog,
        identities: catalog.identities.map((identity) => ({
          ...identity,
          origins: identity.origins
            .map((origin) => origin.trim())
            .filter(Boolean),
        })),
      },
    };
  return { revision, mode, url: url.trim(), ...(token ? { token } : {}) };
}
