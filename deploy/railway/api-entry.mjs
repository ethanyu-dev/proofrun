import { writeFileSync } from 'node:fs';

// Railway 分配 PORT；显式的应用端口仍优先，私网同时支持 IPv4 和 IPv6。
process.env.PROOFRUN_API_PORT ??= process.env.PORT ?? '4100';
process.env.PROOFRUN_API_HOST ??= '::';
// 平台变量可配置 case profile，省去手工向运行容器上传文件；两种来源不能同时启用。
if (process.env.PROOFRUN_CASE_PROFILE_JSON) {
  if (process.env.PROOFRUN_CASE_PROFILE_FILE)
    throw new Error('case profile 的 JSON 与文件配置只能选择一种');
  const path = '/tmp/proofrun-case-profile.json';
  const value = JSON.parse(process.env.PROOFRUN_CASE_PROFILE_JSON);
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  process.env.PROOFRUN_CASE_PROFILE_FILE = path;
}
await import('./dist/main.js');
