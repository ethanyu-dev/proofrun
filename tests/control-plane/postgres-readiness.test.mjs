import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

/** 所有操作仅作用于本测试创建的容器；不连接开发或生产数据库。 */
const execute = promisify(execFile);
const WAIT_SCRIPT = 'tests/control-plane/wait-postgres.sh';
const DOCKER_TIMEOUT_MS = 60_000;
const docker = (...args) =>
  execute('docker', args, { timeout: DOCKER_TIMEOUT_MS });

// 范围：真实 PostgreSQL 临时 Unix socket 实例不能放行 TCP 消费者，并验证超时日志。
// 使用刻意延迟的初始化脚本；不证明 Railway 部署、浏览器执行或模型业务验收通过。
test(
  '数据库等待忽略初始化实例，超时保留测试容器诊断',
  { timeout: 90_000 },
  async (t) => {
    const name = `proofrun-readiness-${randomUUID()}`;
    t.after(() => docker('rm', '-fv', name));
    // 初始化脚本在临时实例已启动后留下标记并暂停，稳定暴露 socket 就绪、TCP 未就绪的窗口。
    await docker(
      'run',
      '-d',
      '--name',
      name,
      '-e',
      'POSTGRES_PASSWORD=proofrun-isolated-test',
      '-e',
      'POSTGRES_DB=proofrun',
      'postgres:17',
      'bash',
      '-c',
      "printf 'touch /tmp/proofrun-initializing\nsleep 8\n' > /docker-entrypoint-initdb.d/pause.sh; exec docker-entrypoint.sh postgres",
    );
    let initializing = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await docker('exec', name, 'test', '-f', '/tmp/proofrun-initializing');
        initializing = true;
        break;
      } catch {
        await delay(100);
      }
    }
    assert.ok(initializing, '应进入临时实例初始化窗口');
    await docker(
      'exec',
      name,
      'pg_isready',
      '-U',
      'postgres',
      '-d',
      'proofrun',
    );
    await assert.rejects(
      docker(
        'exec',
        name,
        'pg_isready',
        '-h',
        '127.0.0.1',
        '-U',
        'postgres',
        '-d',
        'proofrun',
      ),
    );
    await execute('bash', [WAIT_SCRIPT, name], { timeout: 40_000 });
    await docker(
      'exec',
      '-e',
      'PGPASSWORD=proofrun-isolated-test',
      name,
      'psql',
      '-h',
      '127.0.0.1',
      '-U',
      'postgres',
      '-d',
      'proofrun',
      '-c',
      'SELECT 1',
    );
    await docker('stop', name);
    await assert.rejects(execute('bash', [WAIT_SCRIPT, name, '1']), (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /正式 TCP 实例未就绪/);
      assert.match(error.stderr, /exited 0/);
      assert.match(error.stderr, /database system is shut down/);
      return true;
    });
  },
);
