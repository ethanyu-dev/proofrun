import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { localApiEnvironment } from '../../scripts/local-api-environment.mjs';

// 范围：启动器筛选后的真实子进程加载 MCP 配置；不连接数据库、模型或浏览器。
test('本地 API 启动保留公共凭据文件与执行版本，不传递模型秘密', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'proofrun-local-env-'));
  try {
    const file = join(directory, 'mcp.json');
    await writeFile(
      file,
      JSON.stringify([
        {
          principalId: 'local-test',
          tokenSha256: createHash('sha256')
            .update('fixture-only')
            .digest('hex'),
          channels: ['browser', 'verification'],
          scopes: ['runs:read'],
        },
      ]),
      { mode: 0o600 },
    );
    const environment = localApiEnvironment({
      PROOFRUN_DATABASE_URL: 'postgresql://unused/unused',
      PROOFRUN_ADMIN_TOKEN: 'admin-local-fixture-only-00000000000',
      PROOFRUN_WORKER_TOKEN: 'worker-local-fixture-only-0000000000',
      PROOFRUN_MCP_CREDENTIALS_FILE: file,
      PROOFRUN_EXECUTION_RUNTIME_VERSION: '1',
      PROOFRUN_MODEL_API_KEY: 'must-not-reach-api',
      PROOFRUN_BROWSER_MCP_TOKEN: 'must-not-reach-api',
    });
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {loadConfig} from './apps/api/dist/config.js'; const c=loadConfig(); console.log(JSON.stringify({principals:c.publicCredentials.map(p=>p.principalId),version:c.executionRuntimeVersion,model:process.env.PROOFRUN_MODEL_API_KEY,client:process.env.PROOFRUN_BROWSER_MCP_TOKEN}));`,
      ],
      { env: environment },
    );
    assert.deepEqual(JSON.parse(stdout), {
      principals: ['local-test'],
      version: 1,
    });
    assert.deepEqual(localApiEnvironment({}), {});
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
