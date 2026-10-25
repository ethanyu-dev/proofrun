import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

/** 只含本地夹具值；用标记检查启动日志不会输出完整业务配置。 */
const PROFILE = {
  environment: {
    id: 'private-profile-marker',
    nodePool: 'fixture',
    allowIntervention: true,
  },
  budget: { maxActions: 30 },
  executionMode: 'llm',
  evidenceKinds: ['DOM'],
};
/** 子进程只运行真实启动脚本和读配置的替身，不连接数据库、Railway 或业务站点。 */
async function boot(t, { source = 'json', profile = PROFILE, mode } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'proofrun-entry-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'dist'));
  await copyFile(
    new URL('../../deploy/railway/api-entry.mjs', import.meta.url),
    join(directory, 'railway-entry.mjs'),
  );
  await writeFile(
    join(directory, 'dist/main.js'),
    `
    const fs = require('node:fs');
    const path = process.env.PROOFRUN_CASE_PROFILE_FILE;
    fs.writeFileSync(process.env.FIXTURE_OUTPUT, JSON.stringify({
      profile: path ? JSON.parse(fs.readFileSync(path, 'utf8')) : null,
      permissions: path ? fs.statSync(path).mode & 0o777 : null,
      port: process.env.PROOFRUN_API_PORT,
      host: process.env.PROOFRUN_API_HOST,
    }));
  `,
  );
  const original = join(directory, 'original.json');
  await writeFile(original, JSON.stringify(profile));
  const output = join(directory, 'result.json');
  // 环境白名单避免测试继承本机生产配置、令牌或 Node 启动钩子。
  const env = {
    TMPDIR: directory,
    TMP: directory,
    TEMP: directory,
    FIXTURE_OUTPUT: output,
    PORT: '4321',
  };
  if (source === 'json' || source === 'both')
    env.PROOFRUN_CASE_PROFILE_JSON = JSON.stringify(profile);
  if (source === 'file' || source === 'both')
    env.PROOFRUN_CASE_PROFILE_FILE = original;
  if (mode !== undefined) env.PROOFRUN_CASE_EXECUTION_MODE = mode;
  const result = spawnSync(
    process.execPath,
    [join(directory, 'railway-entry.mjs')],
    { cwd: directory, env, encoding: 'utf8', timeout: 5000 },
  );
  assert.equal(result.error, undefined);
  assert.doesNotMatch(result.stdout + result.stderr, /private-profile-marker/);
  assert.deepEqual(JSON.parse(await readFile(original, 'utf8')), profile);
  return {
    ...result,
    config:
      result.status === 0 ? JSON.parse(await readFile(output, 'utf8')) : null,
  };
}

// 范围：真实启动入口读取两种来源的 LLM 配置，并保留其他配置；不启动真实 API 或迁移历史任务。
test('Railway JSON 与文件配置均保持 LLM 单组', async (t) => {
  for (const source of ['json', 'file']) {
    const result = await boot(t, { source });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.config.profile, {
      ...PROFILE,
      executionMode: 'llm',
    });
    assert.equal(result.config.permissions, 0o600);
    assert.equal(result.config.port, '4321');
    assert.equal(result.config.host, '::');
    assert.match(result.stdout, /新 case 执行模式：llm/);
  }
});

// 范围：独立变量支持显式 LLM，并保持 JSON/文件中的配置；不运行真实调度。
test('Railway 独立变量支持显式 LLM', async (t) => {
  for (const source of ['json', 'file'])
    for (const mode of ['llm']) {
      const result = await boot(t, {
        source,
        mode,
        profile: { ...PROFILE, executionMode: 'llm' },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.config.profile.executionMode, mode);
    }
});

// 范围：省略模式和省略整个 profile 的行为保持明确；不以缺配置虚构业务环境。
test('省略模式使用 LLM，未配置 profile 时仍不启用 case 提交', async (t) => {
  const { executionMode: _, ...profile } = PROFILE;
  const defaults = await boot(t, { profile });
  assert.equal(defaults.status, 0, defaults.stderr);
  assert.deepEqual(defaults.config.profile, {
    ...profile,
    executionMode: 'llm',
  });
  const absent = await boot(t, { source: 'none', mode: 'llm' });
  assert.equal(absent.status, 0, absent.stderr);
  assert.equal(absent.config.profile, null);
});

// 范围：配置冲突与非法模式在导入 API 前失败；这里只检查启动边界，完整 profile schema 仍由 API 校验。
test('Railway 拒绝冲突来源、非法模式与非对象 profile', async (t) => {
  for (const mode of ['', 'paralell', 'LLM']) {
    const result = await boot(t, { mode });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /PROOFRUN_CASE_EXECUTION_MODE 只能是/);
  }
  for (const profile of [
    null,
    [],
    'jev',
    { ...PROFILE, executionMode: 'paralell' },
  ]) {
    const result = await boot(t, { profile });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /case profile 必须是对象/);
  }
  const conflict = await boot(t, { source: 'both' });
  assert.notEqual(conflict.status, 0);
  assert.match(conflict.stderr, /JSON 与文件配置只能选择一种/);
});

// 范围：旧执行模式在启动时明确拒绝，不默默切换或启动真实 API。
test('Railway 拒绝已退役的显式模式与旧 profile 模式', async (t) => {
  for (const mode of ['jev', 'parallel']) {
    assert.notEqual((await boot(t, { mode })).status, 0);
    assert.notEqual(
      (await boot(t, { profile: { ...PROFILE, executionMode: mode } })).status,
      0,
    );
  }
});
