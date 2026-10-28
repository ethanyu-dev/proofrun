import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Railway 新 case 固定采用单组默认值，旧 profile 中的模式不再作为部署选择入口。
const DEFAULT_EXECUTION_MODE = 'llm';
// 当前只有 LLM；旧策略与拼写错误都在启动时拒绝。
const EXECUTION_MODES = ['llm'];
const mode = process.env.PROOFRUN_CASE_EXECUTION_MODE ?? DEFAULT_EXECUTION_MODE;
if (!EXECUTION_MODES.includes(mode))
  throw new Error('PROOFRUN_CASE_EXECUTION_MODE 只能是 llm');

// Railway 分配 PORT；显式的应用端口仍优先，私网同时支持 IPv4 和 IPv6。
process.env.PROOFRUN_API_PORT ??= process.env.PORT ?? '4100';
process.env.PROOFRUN_API_HOST ??= '::';
// Railway 变量保存摘要配置，启动时落为私有文件；原始客户端令牌不属于服务配置。
const mcpJson = process.env.PROOFRUN_MCP_CREDENTIALS_JSON;
if (mcpJson && process.env.PROOFRUN_MCP_CREDENTIALS_FILE)
  throw new Error('MCP 凭据的 JSON 与文件配置只能选择一种');
if (mcpJson) {
  let value;
  try {
    value = JSON.parse(mcpJson);
  } catch {
    // JSON 解析器可能附带原文片段，不能让误填的明文令牌进入启动日志。
    throw new Error('MCP 凭据 JSON 格式无效');
  }
  const path = join(
    mkdtempSync(join(tmpdir(), 'proofrun-mcp-credentials-')),
    'credentials.json',
  );
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  process.env.PROOFRUN_MCP_CREDENTIALS_FILE = path;
  delete process.env.PROOFRUN_MCP_CREDENTIALS_JSON;
  // 文件内容仍由 API 的公共凭据验证器校验，不在部署入口另建授权规则。
}
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
    throw new Error('case profile 必须是对象，executionMode 只能是 llm');
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
