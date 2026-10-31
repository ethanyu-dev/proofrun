import assert from 'node:assert/strict';
import test from 'node:test';
import { retainReleaseBackups } from '../../scripts/railway-backups.mjs';
import { railwayGraphqlFailure } from '../../scripts/railway-errors.mjs';

/** 固定创建时间与乱序列表用于验证保留策略，不代表真实云端备份内容。 */
const fixture = (count) =>
  Array.from({ length: count }, (_, index) => ({
    id: `backup-${index}`,
    name: `manual-${index}`,
    createdAt: new Date(Date.UTC(2026, 9, index + 1)).toISOString(),
  })).reverse();
/** 模拟时钟推进避免等待真实二十分钟；不验证网络或平台执行速度。 */
function clock() {
  let time = 0;
  return {
    now: () => time,
    wait: async (ms) => {
      time += ms;
    },
  };
}
const options = { service: 'api', backupName: 'ci-current' };

// 范围：乱序列表按创建时间删除旧手动备份，并等待异步删除后再操作；不验收真实 Railway 删除。
test('十一份备份保留最新九份，同卷删除串行确认', async () => {
  let backups = fixture(11),
    pending,
    polls = 0;
  const removed = [];
  const result = await retainReleaseBackups(
    {
      ...options,
      list: async () => {
        if (pending && ++polls === 2) {
          backups = backups.filter((b) => b.id !== pending);
          pending = undefined;
        }
        return backups;
      },
      remove: async (id) => {
        assert.equal(pending, undefined);
        pending = id;
        polls = 0;
        removed.push(id);
      },
    },
    clock(),
  );
  assert.deepEqual(removed, ['backup-0', 'backup-1']);
  assert.deepEqual(
    result.map((b) => b.id),
    fixture(9).map((_, i) => `backup-${i + 2}`),
  );
});

// 范围：首次运行未满额与同一发布重试均不清理；不证明同名备份的云端可恢复性。
test('未满额或本次备份已存在时不删除', async () => {
  for (const backups of [
    fixture(9),
    fixture(11).map((b, i) => (i === 0 ? { ...b, name: 'ci-current' } : b)),
  ]) {
    await retainReleaseBackups(
      {
        ...options,
        list: async () => backups,
        remove: async () => assert.fail('不应删除'),
      },
      clock(),
    );
  }
});

// 范围：缺失时间与重复身份停止删除；不包含实际数据库损坏恢复。
test('无效列表不能作为删除依据', async () => {
  for (const backups of [
    null,
    [...fixture(10), fixture(10)[0]],
    fixture(10).map((b, i) => (i === 0 ? { ...b, createdAt: 'invalid' } : b)),
  ]) {
    await assert.rejects(
      retainReleaseBackups(
        {
          ...options,
          list: async () => backups,
          remove: async () => assert.fail('不应删除'),
        },
        clock(),
      ),
      /身份或创建时间无效/,
    );
  }
});

// 范围：明确的并发占用可重新读列表后重试；未知写入结果停止，不能重复删除。
test('只重试平台明确拒绝的删除占用', async () => {
  let backups = fixture(10),
    attempts = 0;
  await retainReleaseBackups(
    {
      ...options,
      list: async () => backups,
      remove: async (id) => {
        if (++attempts === 1)
          throw railwayGraphqlFailure('删除', [
            { message: 'Backup deletion already in progress' },
          ]);
        backups = backups.filter((b) => b.id !== id);
      },
    },
    clock(),
  );
  assert.equal(attempts, 2);
  attempts = 0;
  await assert.rejects(
    retainReleaseBackups(
      {
        ...options,
        list: async () => fixture(10),
        remove: async () => {
          attempts++;
          throw new Error('transport timeout');
        },
      },
      clock(),
    ),
    /transport timeout/,
  );
  assert.equal(attempts, 1);
  assert.equal(
    railwayGraphqlFailure('删除', [
      { message: 'Backup deletion already in progress' },
      { message: 'Not Authorized' },
    ]).code,
    undefined,
  );
});

// 范围：异步删除一直未完成时有界停止且不二次提交；时钟为夹具，不等待真实超时。
test('删除未完成或持续占用时超时停止', async () => {
  let attempts = 0;
  await assert.rejects(
    retainReleaseBackups(
      {
        ...options,
        list: async () => fixture(10),
        remove: async () => {
          attempts++;
        },
      },
      clock(),
    ),
    /删除未完成/,
  );
  assert.equal(attempts, 1);
  await assert.rejects(
    retainReleaseBackups(
      {
        ...options,
        list: async () => fixture(10),
        remove: async () => {
          throw railwayGraphqlFailure('删除', [
            { message: 'Backup deletion already in progress' },
          ]);
        },
      },
      clock(),
    ),
    /清理超时/,
  );
});
