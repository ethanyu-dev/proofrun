import assert from 'node:assert/strict';
import test from 'node:test';
import { profileFailure } from '../src/modules/nodes/profile-failure.js';

// 范围：持久错误码的展示优先级；不模拟实际租约或磁盘故障。
test('节点维护失败优先展示具体物理原因，启动错误保留细分原因', () => {
  const lease = profileFailure('DEADLINE_EXCEEDED', 'SESSION_LEASE_EXPIRED');
  assert.equal(lease.code, 'SESSION_LEASE_EXPIRED');
  assert.equal(lease.errorCode, 'DEADLINE_EXCEEDED');
  assert.match(lease.message, /续租/);
  const restore = profileFailure('PROFILE_COPY_FAILED', 'SESSION_START_FAILED');
  assert.equal(restore.code, 'PROFILE_COPY_FAILED');
  assert.match(restore.message, /目录权限/);
  assert.match(
    profileFailure('SESSION_START_TIMEOUT', null).message,
    /启动时限/,
  );
  assert.match(
    profileFailure('COMMAND_DEADLINE_EXCEEDED', null).message,
    /规定时间/,
  );
  assert.match(profileFailure('UNRECOGNIZED_FAILURE', null).message, /错误码/);
  assert.match(profileFailure('constructor', null).message, /错误码/);
});
