import { parseEnv } from 'node:util';
import { readFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { loadConfig } from '../../apps/agent/dist/config.js';
import { ROOT } from './source.mjs';

/** 只从明确指定的配置文件加载模型和浏览器字段，不继承控制面或业务账号凭据。 */
const KEYS = [
  'PROOFRUN_MODEL_BASE_URL',
  'PROOFRUN_MODEL_API_KEY',
  'PROOFRUN_MODEL',
  'PROOFRUN_MODEL_VISION',
  'PROOFRUN_MODEL_TOKEN_PARAMETER',
  'PROOFRUN_MODEL_THINKING',
  'PROOFRUN_MODEL_REASONING_EFFORT',
  'PROOFRUN_MODEL_MAX_TOKENS',
  'PROOFRUN_AGENT_MODEL_MS',
  'PROOFRUN_TEST_BINARY',
  'PROOFRUN_AGENT_BROWSER_BIN',
  'PROOFRUN_CHROME_BIN',
];
/** CLI 版本和本机文件摘要分别记录，不能仅凭路径猜测真实引擎身份。 */
const version = (path) =>
  execFileSync(path, ['--version'], {
    encoding: 'utf8',
    timeout: 10000,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
const hash = (value) => createHash('sha256').update(value).digest('hex');

/** 参数只在进程内进入正式模型适配器，返回的公开配置永远不包含服务地址和密钥。 */
export async function realConfig(envFile) {
  if (envFile) {
    const env = parseEnv(await readFile(resolve(envFile), 'utf8'));
    for (const key of KEYS)
      if (process.env[key] === undefined && env[key] !== undefined)
        process.env[key] = env[key];
  }
  if (
    !process.env.PROOFRUN_MODEL_API_KEY ||
    !process.env.PROOFRUN_MODEL_BASE_URL ||
    !process.env.PROOFRUN_MODEL
  )
    throw new Error(
      '需要配置真实模型 PROOFRUN_MODEL_BASE_URL、PROOFRUN_MODEL_API_KEY、PROOFRUN_MODEL；可用 --env-file 显式读取本地配置',
    );
  process.env.PROOFRUN_WORKER_TOKEN =
    'local-benchmark-no-control-plane-credential';
  const settings = loadConfig();
  const runtime = {
    node: resolve(
      process.env.PROOFRUN_TEST_BINARY ??
        resolve(ROOT, 'target/debug/proofrun-node'),
    ),
    engine: resolve(
      process.env.PROOFRUN_AGENT_BROWSER_BIN ??
        resolve(
          ROOT,
          `.proofrun/bin/agent-browser-${process.platform}-${process.arch}`,
        ),
    ),
    chrome: resolve(
      process.env.PROOFRUN_CHROME_BIN ??
        (process.platform === 'darwin'
          ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
          : '/usr/bin/google-chrome'),
    ),
  };
  for (const path of Object.values(runtime))
    await access(path, constants.X_OK).catch(() => {
      throw new Error(
        '真实浏览器运行依赖缺失：请运行 pnpm benchmark:setup、cargo build -p proofrun-node，或设置 PROOFRUN_TEST_BINARY / PROOFRUN_AGENT_BROWSER_BIN / PROOFRUN_CHROME_BIN',
      );
    });
  const engineVersion = version(runtime.engine),
    chromeVersion = version(runtime.chrome);
  if (engineVersion !== 'agent-browser 0.38.1')
    throw new Error('真实基准只接受项目固定的 agent-browser 0.38.1');
  if (!chromeVersion || !version(runtime.node).includes('proofrun'))
    throw new Error('无法核实浏览器或宿主版本');
  return {
    settings,
    runtime,
    identity: {
      ready: true,
      engineVersion,
      chromeVersion,
      hostSha256: hash(await readFile(runtime.node)),
      engineSha256: hash(await readFile(runtime.engine)),
    },
    publicConfig: {
      vision: settings.vision,
      tokenParameter: settings.tokenParameter,
      maxTokens: settings.maxTokens,
      thinking: settings.thinking ?? 'default',
      reasoningEffort: settings.reasoningEffort ?? 'default',
      endpointFingerprint: hash(settings.modelUrl),
      modelMs: settings.modelMs,
    },
  };
}
