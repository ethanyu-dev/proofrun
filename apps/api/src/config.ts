import { resolve } from 'node:path';
import { loadCaseProfile, type CaseProfile } from './modules/cases/profile.js';

/** 环境变量未覆盖时的控制面运行界限。 */
const DEFAULTS = {
  port: 4100,
  workerLeaseMs: 15_000,
  nodeLeaseMs: 20_000,
  tickMs: 250,
};

/** 控制面只支持一个活动实例；队列、租约和消息均持久化到数据库。 */
export interface ApiConfig {
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
  const caseProfile = loadCaseProfile(process.env.PROOFRUN_CASE_PROFILE_FILE);
  return {
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
    tickMs: integer('PROOFRUN_API_TICK_MS', DEFAULTS.tickMs, 50, 5000),
  };
}
