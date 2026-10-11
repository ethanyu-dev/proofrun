import assert from 'node:assert/strict';
import test from 'node:test';
import {
  validateCatalog,
  resolveSession,
  type IdentityCatalog,
} from '../src/modules/identities/catalog.js';
import { sessionAuth } from '../src/modules/scheduling/auth.js';
import { task } from './fixture.js';
import type { VerificationTask } from '@proofrun/contracts';

/** 身份元数据仅为夹具，不代表真实账号具备这些角色或可登录。 */
const catalog: IdentityCatalog = {
  identities: [
    {
      id: 'member',
      label: '团队测试身份',
      accountKey: 'account-1',
      origins: ['https://example.test'],
      checks: [
        {
          id: 'team',
          description: '当前为测试团队',
          method: 'text',
          value: '测试团队',
        },
      ],
      maxConcurrent: 1,
    },
  ],
  pools: [{ id: 'members', identityRefs: ['member'] }],
  sites: [
    {
      id: 'site',
      hostname: 'example.test',
      environment: 'test',
      nodePool: 'test',
      poolRef: 'members',
    },
  ],
};
const env = { id: 'test', nodePool: 'test' };

// 范围：新身份模式隔离历史站点槽；不启动 Chromium 或真实人工登录。
test('访客不恢复状态，未指定身份的人工会话不共享账号槽', () => {
  const base = task('one') as VerificationTask;
  base.environment.reuseAuth = true;
  base.sessionPlan = resolveSession(
    catalog,
    { mode: 'guest' },
    'https://example.test',
    env,
  );
  assert.equal(sessionAuth(base), null);
  base.sessionPlan = resolveSession(
    catalog,
    undefined,
    'https://example.test',
    env,
  );
  const first = sessionAuth(base)!;
  assert.equal(first.restore, false);
  assert.notEqual(
    sessionAuth({ ...base, taskId: 'two' })!.stateId,
    first.stateId,
  );
});

// 范围：站点边界、规则冲突与条件不可替换；不验证浏览器实际身份。
test('域名和条件不能使账号跨站点使用，规则冲突明确拒绝', () => {
  assert.equal(validateCatalog(catalog).identities.length, 1);
  assert.equal(
    resolveSession(catalog, { mode: 'auto' }, 'https://example.test/path', env)
      .mode,
    'pool',
  );
  assert.throws(
    () =>
      resolveSession(
        catalog,
        { mode: 'identity', identityRef: 'member' },
        'https://evil.test',
        env,
      ),
    /站点/,
  );
  assert.throws(
    () =>
      resolveSession(
        catalog,
        { mode: 'auto' },
        'https://example.test.evil.test',
        env,
      ),
    /规则/,
  );
  assert.throws(
    () =>
      resolveSession(
        {
          ...catalog,
          sites: [...catalog.sites, { ...catalog.sites[0]!, id: 'duplicate' }],
        },
        { mode: 'auto' },
        'https://example.test',
        env,
      ),
    /唯一/,
  );
  assert.throws(
    () =>
      resolveSession(
        catalog,
        {
          mode: 'identity',
          identityRef: 'member',
          requirements: [
            { id: 'team', description: '放宽角色', method: 'manual' },
          ],
        },
        'https://example.test',
        env,
      ),
    /冲突/,
  );
});

// 范围：秘密和底层账号容量配置不能混入元数据；不访问外部凭据库。
test('拒绝身份中的密码与同一底层账号的并发配置歧义', () => {
  assert.throws(() =>
    validateCatalog({
      ...catalog,
      identities: [{ ...catalog.identities[0], password: 'fixture' }],
    }),
  );
  assert.throws(() =>
    validateCatalog({
      ...catalog,
      identities: [
        ...catalog.identities,
        { ...catalog.identities[0]!, id: 'alias', maxConcurrent: 2 },
      ],
    }),
  );
});
