import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { repairWatchPaths } from '../../scripts/railway-watch-paths.mjs';

/** 两个环境和数据库混合夹具，用于发现误选环境或越界修改服务。 */
function snapshot() {
  return {
    data: {
      project: {
        id: 'project-id',
        name: 'proofrun',
        environments: {
          edges: ['staging', 'production'].map((name) => ({
            node: {
              id: `${name}-id`,
              name,
              serviceInstances: {
                edges: ['api', 'web', 'agent', 'Postgres'].map(
                  (serviceName) => ({
                    node: {
                      serviceId: `${name}-${serviceName}`,
                      serviceName,
                      watchPatterns: serviceName === 'Postgres' ? [] : ['/**'],
                    },
                  }),
                ),
              },
            },
          })),
        },
      },
    },
  };
}

// 范围：实际参考文件明确关闭过滤；不证明 Railway 自动加载这些参考文件或匹配引擎行为。
test('三个应用的参考配置均禁用路径过滤', async () => {
  for (const name of ['api', 'web', 'agent']) {
    const config = JSON.parse(
      await readFile(
        new URL(`../../deploy/railway/${name}.json`, import.meta.url),
        'utf8',
      ),
    );
    assert.deepEqual(config.build.watchPatterns, []);
  }
});

// 范围：预览选定环境且只调用查询；CLI 返回值为夹具，不连接真实 Railway。
test('默认预览不写入，并可按环境 ID 选择', async () => {
  const calls = [];
  const result = await repairWatchPaths(
    { projectId: 'project-id', environment: 'production-id' },
    async (args) => {
      calls.push(args);
      return snapshot();
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'api');
  assert.deepEqual(JSON.parse(calls[0][3]), { project: 'project-id' });
  assert.equal(result.environment.name, 'production');
  assert.equal(result.staged, false);
  assert.deepEqual(
    result.services.map((service) => service.id),
    ['production-api', 'production-web', 'production-agent'],
  );
});

// 范围：仅暂存指定环境中有差异的应用字段，不能隐式提交已有变更；不验证平台实际写入或部署。
test('暂存只清空需要修复的 Watch Paths，并保持环境显式', async () => {
  const data = snapshot();
  data.data.project.environments.edges[1].node.serviceInstances.edges[1].node.watchPatterns =
    [];
  const calls = [];
  const result = await repairWatchPaths(
    { projectId: 'project-id', environment: 'production', stage: true },
    async (args) => {
      calls.push(args);
      return calls.length === 1 ? data : {};
    },
  );
  assert.equal(result.staged, true);
  assert.deepEqual(calls[1], [
    'environment',
    'edit',
    '--project',
    'project-id',
    '--environment',
    'production-id',
    '--service-config',
    'production-api',
    'build.watchPatterns',
    '[]',
    '--service-config',
    'production-agent',
    'build.watchPatterns',
    '[]',
    '--stage',
    '--json',
  ]);
});

// 范围：错误项目、环境、服务或异常响应均在任何暂存前终止；不验证平台权限控制。
test('目标不完整或不唯一时拒绝部分暂存', async () => {
  for (const change of [
    (data) => {
      data.data.project.id = 'wrong-project';
    },
    (data) => {
      data.errors = [{ message: 'denied' }];
    },
    (data) => {
      data.data.project.environments.edges.pop();
    },
    (data) => {
      data.data.project.environments.edges.push(
        structuredClone(data.data.project.environments.edges[1]),
      );
    },
    (data) => {
      data.data.project.environments.edges[1].node.serviceInstances.edges.splice(
        1,
        1,
      );
    },
    (data) => {
      data.data.project.environments.edges[1].node.serviceInstances.edges[0].node.watchPatterns =
        null;
    },
    (data) => {
      const rows =
        data.data.project.environments.edges[1].node.serviceInstances.edges;
      rows.push(structuredClone(rows[0]));
    },
  ]) {
    const data = snapshot();
    change(data);
    let calls = 0;
    await assert.rejects(
      repairWatchPaths(
        { projectId: 'project-id', environment: 'production', stage: true },
        async () => {
          calls++;
          return data;
        },
      ),
      /未暂存任何配置/,
    );
    assert.equal(calls, 1);
  }
  await assert.rejects(
    repairWatchPaths({ environment: 'production' }, async () =>
      assert.fail('不能访问 Railway'),
    ),
    /必须显式指定/,
  );
});

// 范围：空规则不产生重复暂存，CLI 写入错误会向调用方传播；不保证网络故障时远端未暂存。
test('无需修复时不写入，暂存失败不报告成功', async () => {
  const data = snapshot();
  for (const { node } of data.data.project.environments.edges[1].node
    .serviceInstances.edges)
    node.watchPatterns = [];
  let calls = 0;
  const options = {
    projectId: 'project-id',
    environment: 'production',
    stage: true,
  };
  const result = await repairWatchPaths(options, async () => {
    calls++;
    return data;
  });
  assert.equal(calls, 1);
  assert.equal(result.staged, false);
  await assert.rejects(
    repairWatchPaths(options, async (args) => {
      if (args[0] === 'api') return snapshot();
      throw new Error('fixture: staging failed');
    }),
    /staging failed/,
  );
});
