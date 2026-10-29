import type { ReleaseIdentity } from '@proofrun/contracts/release';
import {
  loadDevPass,
  type DevPassConfig,
} from './modules/account-providers/config.js';
import { resolve } from 'node:path';
import {
  loadPublicCredentials,
  type PublicCredential,
} from './modules/public-execution/auth.js';
import { loadCaseProfile, type CaseProfile } from './modules/cases/profile.js';
import {
  feishuConfig,
  type FeishuConfig,
} from './modules/notifications/feishu.js';

/** 环境变量未覆盖时的控制面运行界限。 */
const DEFAULTS = {
  port: 4100,
  workerLeaseMs: 15_000,
  nodeLeaseMs: 20_000,
  tickMs: 250,
  humanWaitMs: 30 * 60_000,
};

/** 控制面只支持一个活动实例；队列、租约和消息均持久化到数据库。 */
export interface ApiConfig {
  /** 基准仅使用显式配置的独立节点池，环境名称用于归档筛选。 */
  benchmarkNodePool?: string;
  benchmarkEnvironment?: string;
  /** 程序化测试可注入构建身份；部署进程只读取应用旁的清单。 */
  buildIdentity?: ReleaseIdentity;
  /** 新入队运行的冻结驱动版本；省略保留程序化旧接入，部署配置默认启用版本 1。 */
  executionRuntimeVersion?: 0 | 1;
  /** 可选任务级 MCP 服务凭据；未配置时不注册公共接入端点。 */
  publicCredentials?: PublicCredential[];
  /** 外部控制空闲期限；不覆盖任务、账号或步骤的硬期限。 */
  externalIdleMs?: number;
  /** 受控的外部账号来源，密钥不进入任务。 */
  devPass?: DevPassConfig;
  /** 可选飞书企业自建应用；未配置时关闭 Case 生命周期通知。 */
  feishu?: FeishuConfig;
  /** 每次人工请求的独立等待期限；默认三十分钟，旧等待不补造截止时间。 */
  humanWaitMs?: number;
  /** 平台预配置的 case 执行环境；省略时不接收新 case。 */
  caseProfile?: CaseProfile;
  /** 独立 PostgreSQL 数据库地址。 */
  databaseUrl: string;
  /** 管理接口凭据；不下发给浏览器节点或执行 worker。 */
  adminToken: string;
  /** worker 领取任务的凭据；领取后使用单次执行的独立令牌。 */
  workerToken: string;
  /** 外部可访问地址，用于配对响应和证据链接。 */
  publicUrl: string;
  /** 本地前后端分端口时使用独立处理页地址；生产默认同源。 */
  consoleUrl?: string;
  /** 证据目录，单实例用持久磁盘，HA 副本必须挂载同一共享目录。 */
  artifactDirectory: string;
  /** HTTP 监听参数，TLS 可由同源反向代理终止。 */
  host: string;
  /** API 本机监听端口，不影响 publicUrl 的外部端口。 */
  port: number;
  /** worker 失联后撤销执行权限的窗口。 */
  workerLeaseMs: number;
  /** 节点授权窗口，实际值还受节点报告的上限约束。 */
  nodeLeaseMs: number;
  /** 持久命令投递和到期清理的扫描间隔。 */
  tickMs: number;
}

/** 读取受限整数配置，拒绝 NaN 和无界资源参数。 */
function integer(
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(`Invalid ${name}`);
  return value;
}

/** 启动时验证必要依赖配置；不提供可误用于部署的默认凭据。 */
export function loadConfig(): ApiConfig {
  const executionRuntimeVersion = Number(
    process.env.PROOFRUN_EXECUTION_RUNTIME_VERSION ?? '1',
  );
  if (executionRuntimeVersion !== 0 && executionRuntimeVersion !== 1)
    throw new Error('PROOFRUN_EXECUTION_RUNTIME_VERSION must be 0 or 1');
  const databaseUrl = process.env.PROOFRUN_DATABASE_URL ?? '';
  const adminToken = process.env.PROOFRUN_ADMIN_TOKEN ?? '';
  const workerToken = process.env.PROOFRUN_WORKER_TOKEN ?? '';
  if (
    !databaseUrl ||
    adminToken.length < 32 ||
    workerToken.length < 32 ||
    adminToken === workerToken
  ) {
    throw new Error(
      'Set PROOFRUN_DATABASE_URL and distinct ADMIN/WORKER tokens of at least 32 characters',
    );
  }
  const port = integer('PROOFRUN_API_PORT', DEFAULTS.port, 1, 65535);
  const publicUrl = new URL(
    process.env.PROOFRUN_PUBLIC_URL ?? `http://127.0.0.1:${port}`,
  );
  if (
    !['http:', 'https:'].includes(publicUrl.protocol) ||
    publicUrl.username ||
    publicUrl.password ||
    publicUrl.pathname !== '/' ||
    publicUrl.search ||
    publicUrl.hash
  ) {
    throw new Error(
      'PROOFRUN_PUBLIC_URL must be an HTTP(S) origin without credentials',
    );
  }
  const consoleUrl = new URL(
    process.env.PROOFRUN_CONSOLE_URL || publicUrl.origin,
  );
  if (
    !['http:', 'https:'].includes(consoleUrl.protocol) ||
    consoleUrl.username ||
    consoleUrl.password ||
    consoleUrl.pathname !== '/' ||
    consoleUrl.search ||
    consoleUrl.hash
  )
    throw new Error(
      'PROOFRUN_CONSOLE_URL must be an HTTP(S) origin without credentials',
    );
  if (
    [
      'PROOFRUN_IDENTITY_CATALOG_FILE',
      'PROOFRUN_IDENTITY_CATALOG_URL',
      'PROOFRUN_IDENTITY_CATALOG_TOKEN_FILE',
      'PROOFRUN_IDENTITY_SECRET_DIRECTORY',
    ].some((key) => process.env[key])
  )
    throw new Error(
      '本地身份库已移除，请移除旧 PROOFRUN_IDENTITY_* 配置并使用 DevPass',
    );
  const caseProfile = loadCaseProfile(process.env.PROOFRUN_CASE_PROFILE_FILE);
  const feishu = feishuConfig(
    process.env.PROOFRUN_FEISHU_APP_ID,
    process.env.PROOFRUN_FEISHU_APP_SECRET,
    process.env.PROOFRUN_FEISHU_CHAT_ID,
  );
  if (
    !feishu &&
    (process.env.PROOFRUN_FEISHU_WEBHOOK_URL ||
      process.env.PROOFRUN_FEISHU_SIGNING_SECRET)
  )
    throw new Error(
      '飞书通知已改为企业自建应用，请移除旧 WEBHOOK_URL/SIGNING_SECRET 并配置 APP_ID、APP_SECRET、CHAT_ID',
    );
  const devPass = loadDevPass(process.env.PROOFRUN_DEVPASS_CONFIG_FILE);
  const publicCredentials = loadPublicCredentials(
    process.env.PROOFRUN_MCP_CREDENTIALS_FILE,
  );
  return {
    ...(process.env.PROOFRUN_BENCHMARK_NODE_POOL
      ? { benchmarkNodePool: process.env.PROOFRUN_BENCHMARK_NODE_POOL }
      : {}),
    ...(process.env.PROOFRUN_BENCHMARK_ENVIRONMENT
      ? { benchmarkEnvironment: process.env.PROOFRUN_BENCHMARK_ENVIRONMENT }
      : {}),
    executionRuntimeVersion,
    ...(publicCredentials ? { publicCredentials } : {}),
    ...(devPass ? { devPass } : {}),
    ...(feishu ? { feishu } : {}),
    ...(caseProfile ? { caseProfile } : {}),
    databaseUrl,
    adminToken,
    workerToken,
    publicUrl: publicUrl.origin,
    consoleUrl: consoleUrl.origin,
    artifactDirectory: resolve(
      process.env.PROOFRUN_ARTIFACT_DIRECTORY ?? '.proofrun/api-artifacts',
    ),
    host: process.env.PROOFRUN_API_HOST ?? '127.0.0.1',
    port,
    workerLeaseMs: integer(
      'PROOFRUN_WORKER_LEASE_MS',
      DEFAULTS.workerLeaseMs,
      1000,
      60_000,
    ),
    nodeLeaseMs: integer(
      'PROOFRUN_NODE_LEASE_MS',
      DEFAULTS.nodeLeaseMs,
      1000,
      60_000,
    ),
    humanWaitMs: integer(
      'PROOFRUN_HUMAN_WAIT_MS',
      DEFAULTS.humanWaitMs,
      1000,
      86_400_000,
    ),
    tickMs: integer('PROOFRUN_API_TICK_MS', DEFAULTS.tickMs, 50, 5000),
  };
}
