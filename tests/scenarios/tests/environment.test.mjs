import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

/** 与 Linux 编排器一致的非秘密声明；网络字段只描述测评环境，不构造模型 context。 */
const ENVIRONMENT = {
  mode: 'llm',
  modelKind: 'scripted',
  model: 'local-evaluation-fixture',
  vision: true,
  configSha256: 'a'.repeat(64),
};

// 范围：真实 CLI 的环境声明边界；故意不提供控制面配置，不启动浏览器、数据库或模型。
test('测评 CLI 接受 Linux 网络声明并拒绝旧模式与任意扩展', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'proofrun-evaluation-env-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'environment.json');
  const invoke = async (environment) => {
    await writeFile(path, JSON.stringify(environment));
    // 不继承本机凭据或服务地址，接受声明后必须停在下一条配置检查。
    const result = spawnSync(
      process.execPath,
      [
        'scripts/evaluate-e2e.mjs',
        '--output',
        join(root, 'run'),
        '--environment',
        path,
      ],
      { env: {}, encoding: 'utf8', timeout: 10000 },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    return result.stderr;
  };
  for (const network of [undefined, 'runtime-default', 'explicit-env-proxy']) {
    assert.match(
      await invoke({ ...ENVIRONMENT, ...(network ? { network } : {}) }),
      /需要显式控制面、测试页面 origin 与私有夹具 socket/,
    );
  }
  for (const extra of [
    { network: 'https://proxy.invalid' },
    { network: null },
    { network: {} },
    { mode: 'jev' },
    { jevNetwork: 'runtime-default' },
    { executionPolicy: 'planned-v1' },
    { apiKey: 'fixture-only' },
  ]) {
    assert.match(await invoke({ ...ENVIRONMENT, ...extra }), /环境声明无效/);
  }
});
