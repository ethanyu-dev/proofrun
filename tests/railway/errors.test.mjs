import test from 'node:test';
import assert from 'node:assert/strict';
import { railwayGraphqlFailure } from '../../scripts/railway-errors.mjs';

// 范围：确认已知配额及权限错误可诊断；仅字符串夹具，不证明 Railway 的实时状态。
test('Railway 错误保留配额、阶段和可定位的追踪号', () => {
  assert.match(
    railwayGraphqlFailure('api 创建备份', [
      {
        message: 'Plan limit of 10 backups per volume exceeded',
        extensions: { code: 'BAD_USER_INPUT' },
        traceId: '8133735940239583290',
      },
    ]).message,
    /api 创建备份.*上限 10.*BAD_USER_INPUT.*8133735940239583290/,
  );
  assert.match(
    railwayGraphqlFailure('查询备份', [{ message: 'Not Authorized' }]).message,
    /权限不足/,
  );
});

// 范围：未知错误中的变量值、伪造错误码及追踪号不得进入日志；不覆盖平台新增的错误分类。
test('Railway 未知错误不回显凭据或原始响应', () => {
  const secret = 'fixture-sensitive-token';
  const error = railwayGraphqlFailure('查询备份', [
    { message: secret, extensions: { code: secret }, traceId: secret },
  ]);
  assert.match(error.message, /平台拒绝请求/);
  assert(!error.message.includes(secret));
  assert.equal(error.cause, undefined);
});
