/** 服务环境只分发职责所需配置；Console 不继承管理员或模型密钥。 */
const API_KEYS = [
  'PROOFRUN_DATABASE_URL',
  'PROOFRUN_ADMIN_TOKEN',
  'PROOFRUN_WORKER_TOKEN',
  'PROOFRUN_PUBLIC_URL',
  'PROOFRUN_CONSOLE_URL',
  'PROOFRUN_FEISHU_APP_ID',
  'PROOFRUN_FEISHU_APP_SECRET',
  'PROOFRUN_FEISHU_CHAT_ID',
  'PROOFRUN_ARTIFACT_DIRECTORY',
  'PROOFRUN_CASE_PROFILE_FILE',
  'PROOFRUN_DEVPASS_CONFIG_FILE',
  'PROOFRUN_MCP_CREDENTIALS_FILE',
  'PROOFRUN_EXECUTION_RUNTIME_VERSION',
  'PROOFRUN_API_HOST',
  'PROOFRUN_API_PORT',
];
/** 仅把 API 白名单配置交给子进程；缺失项不转成字符串 undefined。 */
export function localApiEnvironment(settings) {
  return Object.fromEntries(
    API_KEYS.filter((key) => settings[key] !== undefined).map((key) => [
      key,
      settings[key],
    ]),
  );
}
