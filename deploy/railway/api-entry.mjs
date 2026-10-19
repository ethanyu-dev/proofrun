import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Railway 新 case 固定采用单组默认值，旧 profile 中的模式不再作为部署选择入口。
const DEFAULT_EXECUTION_MODE = 'jev';
// 纯 LLM 和双组对照必须通过独立部署变量明确启用，拼写错误不能静默降级。
const EXECUTION_MODES = ['llm', 'jev', 'parallel'];
const mode = process.env.PROOFRUN_CASE_EXECUTION_MODE ?? DEFAULT_EXECUTION_MODE;
if (!EXECUTION_MODES.includes(mode))
  throw new Error('PROOFRUN_CASE_EXECUTION_MODE 只能是 llm、jev 或 parallel');

// Railway 分配 PORT；显式的应用端口仍优先，私网同时支持 IPv4 和 IPv6。
process.env.PROOFRUN_API_PORT ??= process.env.PORT ?? '4100';
process.env.PROOFRUN_API_HOST ??= '::';
// 平台变量可配置 case profile，省去手工向运行容器上传文件；两种来源不能同时启用。
const profileJson = process.env.PROOFRUN_CASE_PROFILE_JSON;
const profileFile = process.env.PROOFRUN_CASE_PROFILE_FILE;
if (profileJson && profileFile)
  throw new Error('case profile 的 JSON 与文件配置只能选择一种');
if (profileJson || profileFile) {
  const value = JSON.parse(profileJson || readFileSync(profileFile, 'utf8'));
  // 只迁移合法的旧模式，未知字段仍交给 API 校验，避免覆盖掉原本应拒绝的配置错误。
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (value.executionMode !== undefined &&
      !EXECUTION_MODES.includes(value.executionMode))
  )
    throw new Error(
      'case profile 必须是对象，executionMode 只能是 llm、jev 或 parallel',
    );
  if (value.executionMode !== undefined && value.executionMode !== mode)
    console.warn(
      `忽略旧 case profile.executionMode=${value.executionMode}；Railway 新 case 使用 ${mode}，请通过 PROOFRUN_CASE_EXECUTION_MODE 选择模式`,
    );
  // 使用私有临时副本，不能改写挂载的配置文件；已有任务的冻结定义不经过该入口。
  const path = join(
    mkdtempSync(join(tmpdir(), 'proofrun-case-profile-')),
    'profile.json',
  );
  writeFileSync(path, JSON.stringify({ ...value, executionMode: mode }), {
    mode: 0o600,
  });
  process.env.PROOFRUN_CASE_PROFILE_FILE = path;
  console.info(`Railway 新 case 执行模式：${mode}`);
}
await import('./dist/main.js');
