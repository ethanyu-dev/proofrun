import { readFileSync } from 'node:fs';
import { domainToASCII } from 'node:url';
import {
  validateSessionPlan,
  type SessionPlan,
  type SessionRequest,
} from '@proofrun/contracts';
import { ApiError, canonical } from '../../domain.js';

/** 自动准备最多两分钟，人工等待仍由控制面暂停；不借用业务步骤额度。 */
export const PREPARATION_MS = 120_000;
/** 元数据提供方不得返回密码或 Cookie；秘密由节点按 loginRef 单独解析。 */
export type TestIdentity = SessionPlan['candidates'][number];
/** 站点规则只选择身份，不能覆盖节点域名路由。 */
export interface SiteRule {
  id: string;
  hostname: string;
  pathPrefix?: string;
  environment: string;
  nodePool: string;
  identityRef?: string;
  poolRef?: string;
}
/** 身份别名共享 accountKey 时仍受同一底层账号的并发上限约束。 */
export interface IdentityCatalog {
  identities: TestIdentity[];
  pools: Array<{ id: string; identityRefs: string[] }>;
  sites: SiteRule[];
}
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const EMPTY: IdentityCatalog = { identities: [], pools: [], sites: [] };

/** 域名按 DNS 标签匹配，通配不包含裸域，不允许 suffix 伪装。 */
export function siteScore(rule: SiteRule, target: URL): number {
  const wildcard = rule.hostname.startsWith('*.');
  const host = domainToASCII(
    wildcard ? rule.hostname.slice(2) : rule.hostname,
  ).toLowerCase();
  const match = wildcard
    ? target.hostname.endsWith(`.${host}`)
    : target.hostname === host;
  const path = rule.pathPrefix ?? '/';
  if (
    !match ||
    !(
      target.pathname === path ||
      target.pathname.startsWith(path.endsWith('/') ? path : `${path}/`)
    )
  )
    return -1;
  return (wildcard ? 0 : 1_000_000) + host.length * 1000 + path.length;
}

/** 配置错误在启动时发现；不能将外部库返回的任意字段带入任务。 */
export function validateCatalog(value: unknown): IdentityCatalog {
  const invalid = () => new Error('测试身份库配置无效');
  if (!value || typeof value !== 'object') throw invalid();
  const c = value as IdentityCatalog;
  if (
    Object.keys(c).some((k) => !['identities', 'pools', 'sites'].includes(k)) ||
    !Array.isArray(c.identities) ||
    !Array.isArray(c.pools) ||
    !Array.isArray(c.sites) ||
    c.identities.length > 256 ||
    c.pools.length > 128 ||
    c.sites.length > 256
  )
    throw invalid();
  const ids = new Set<string>();
  const accountLimits = new Map<string, number>();
  for (const identity of c.identities) {
    if (
      !validateSessionPlan({
        version: 1,
        mode: 'identity',
        candidates: [identity],
        requirements: [],
        preparationMs: PREPARATION_MS,
      }) ||
      ids.has(identity.id) ||
      !identity.origins.length ||
      !identity.checks.length ||
      new Set(identity.checks.map((v) => v.id)).size !== identity.checks.length
    )
      throw invalid();
    if (
      accountLimits.has(identity.accountKey) &&
      accountLimits.get(identity.accountKey) !== identity.maxConcurrent
    )
      throw invalid();
    accountLimits.set(identity.accountKey, identity.maxConcurrent);
    ids.add(identity.id);
    for (const origin of identity.origins) {
      const url = new URL(origin);
      if (
        !['https:', 'http:'].includes(url.protocol) ||
        url.origin !== origin ||
        url.username ||
        url.password
      )
        throw invalid();
    }
    if (!!identity.nodeId !== !!identity.stateId) throw invalid();
  }
  const pools = new Set<string>();
  for (const pool of c.pools) {
    if (
      !pool ||
      Object.keys(pool).some((k) => !['id', 'identityRefs'].includes(k)) ||
      !ID.test(pool.id) ||
      pools.has(pool.id) ||
      !Array.isArray(pool.identityRefs) ||
      !pool.identityRefs.length ||
      pool.identityRefs.length > 32 ||
      new Set(pool.identityRefs).size !== pool.identityRefs.length ||
      pool.identityRefs.some((id) => !ids.has(id))
    )
      throw invalid();
    pools.add(pool.id);
  }
  const rules = new Set<string>();
  for (const rule of c.sites) {
    if (
      !rule ||
      Object.keys(rule).some(
        (k) =>
          ![
            'id',
            'hostname',
            'pathPrefix',
            'environment',
            'nodePool',
            'identityRef',
            'poolRef',
          ].includes(k),
      ) ||
      !ID.test(rule.id) ||
      rules.has(rule.id) ||
      typeof rule.environment !== 'string' ||
      !rule.environment ||
      !ID.test(rule.nodePool) ||
      typeof rule.hostname !== 'string' ||
      !/^(\*\.)?[a-zA-Z0-9.-]+$/.test(rule.hostname) ||
      !domainToASCII(rule.hostname.replace(/^\*\./, '')) ||
      (rule.pathPrefix !== undefined &&
        (!rule.pathPrefix.startsWith('/') || /[?#]/.test(rule.pathPrefix))) ||
      Number(!!rule.identityRef) + Number(!!rule.poolRef) !== 1 ||
      (rule.identityRef && !ids.has(rule.identityRef)) ||
      (rule.poolRef && !pools.has(rule.poolRef))
    )
      throw invalid();
    rules.add(rule.id);
  }
  return structuredClone(c);
}

/** 缺少配置等于没有可自动选择的身份，不能回退到历史站点登录槽。 */
export function loadIdentityCatalog(path?: string): IdentityCatalog {
  return path
    ? validateCatalog(JSON.parse(readFileSync(path, 'utf8')))
    : structuredClone(EMPTY);
}

/** 仅冻结非敏感候选和条件；账号池实际分配由数据库领取事务完成。 */
export function resolveSession(
  catalog: IdentityCatalog,
  request: SessionRequest | undefined,
  entry: string,
  environment: { id: string; nodePool: string },
): SessionPlan {
  let selection = request ?? { mode: 'manual' as const };
  const target = new URL(entry);
  if (selection.mode === 'auto') {
    const rules = catalog.sites
      .filter(
        (r) =>
          r.environment === environment.id &&
          r.nodePool === environment.nodePool,
      )
      .map((rule) => ({ rule, score: siteScore(rule, target) }))
      .filter((r) => r.score >= 0)
      .sort((a, b) => b.score - a.score);
    if (!rules.length || (rules[1] && rules[0]!.score === rules[1].score))
      throw new ApiError(
        422,
        'IDENTITY_RULE_AMBIGUOUS',
        '没有唯一匹配的测试身份规则',
      );
    const rule = rules[0]!.rule;
    selection = {
      ...selection,
      mode: rule.identityRef ? 'identity' : 'pool',
      ...(rule.identityRef
        ? { identityRef: rule.identityRef }
        : { poolRef: rule.poolRef! }),
    };
  }
  const selected =
    selection.mode === 'identity'
      ? [selection.identityRef!]
      : selection.mode === 'pool'
        ? catalog.pools.find((p) => p.id === selection.poolRef)?.identityRefs
        : [];
  if (!selected)
    throw new ApiError(422, 'IDENTITY_MISSING', '测试账号池不存在');
  const candidates = selected.map((id) => {
    const identity = catalog.identities.find((i) => i.id === id);
    if (!identity)
      throw new ApiError(422, 'IDENTITY_MISSING', '测试身份不存在');
    if (!(identity.origins as readonly string[]).includes(target.origin))
      throw new ApiError(
        422,
        'IDENTITY_ORIGIN_MISMATCH',
        '测试身份不适用于目标站点',
      );
    return structuredClone(identity);
  });
  // 同名要求不能由调用者替换，前置条件也不能通过重复 ID 隐藏。
  for (const identity of candidates)
    for (const requirement of selection.requirements ?? []) {
      const known = identity.checks.find((c) => c.id === requirement.id);
      if (known && canonical(known) !== canonical(requirement))
        throw new ApiError(
          422,
          'IDENTITY_CHECK_CONFLICT',
          '身份条件与平台配置冲突',
        );
    }
  return {
    version: 1,
    mode: selection.mode as SessionPlan['mode'],
    candidates,
    requirements: structuredClone(selection.requirements ?? []),
    preparationMs: PREPARATION_MS,
  };
}
