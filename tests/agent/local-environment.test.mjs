import assert from 'node:assert/strict';
import test from 'node:test';
import { localApiEnvironment } from '../../scripts/local-api-environment.mjs';

// 范围：本地启动白名单保留内置执行与 DevPass 配置，屏蔽旧接入和模型秘密；不启动数据库或浏览器。
test('本地 API 环境仅传递当前支持的服务配置', () => {
  assert.deepEqual(
    localApiEnvironment({
      PROOFRUN_EXECUTION_RUNTIME_VERSION: '1',
      PROOFRUN_DEVPASS_CONFIG_FILE: '/fixture/devpass.json',
      PROOFRUN_MCP_CREDENTIALS_FILE: '/fixture/retired.json',
      PROOFRUN_MCP_CREDENTIALS_JSON: 'retired',
      PROOFRUN_MODEL_API_KEY: 'fixture-secret',
      PROOFRUN_BROWSER_MCP_TOKEN: 'fixture-secret',
    }),
    {
      PROOFRUN_EXECUTION_RUNTIME_VERSION: '1',
      PROOFRUN_DEVPASS_CONFIG_FILE: '/fixture/devpass.json',
    },
  );
  assert.deepEqual(localApiEnvironment({}), {});
});
