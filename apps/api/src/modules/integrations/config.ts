import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { ApiError, requireToken } from '../../domain.js';

/** 远端仅负责消息投递；三个方向的凭据不能复用。配置文件应由部署系统限制读取权限。 */
export interface IntegrationConfig {
  /** 飞书机器人绑定与投递服务。 */
  connections: Array<{
    /** 固定集成身份，与 cc-connect 返回值一致。 */
    id: string;
    /** 受部署控制的通知服务来源，不接受请求覆盖。 */
    url: string;
    /** ProofRun 向通知服务提交事件及读取回执的凭据。 */
    deliveryToken: string;
    /** 通知服务回读 HITL 视图的独立凭据。 */
    viewToken: string;
    /** 允许新提交选择的稳定绑定与冻结版本。 */
    bindings: Array<{ ref: string; version: number }>;
  }>;
  /** MCP 调用者只能使用明确允许的通知绑定，并只操作自己提交的 case。 */
  clients: Array<{
    /** 调用者身份不能在更换凭据时变化。 */
    id: string;
    /** 仅允许本客户端操作的 MCP 与 REST 凭据。 */
    token: string;
    /** 指向部署中的固定连接。 */
    integrationId: string;
    /** 可选绑定的白名单，不是飞书群身份。 */
    bindingRefs: string[];
    /** 只影响新 case；既有 case 沿用其快照。 */
    defaultBindingRef: string;
  }>;
}
export type IntegrationClient = IntegrationConfig['clients'][number];
export type IntegrationConnection = IntegrationConfig['connections'][number];
/** 每个外部 HTTP 请求的独立截止时间，不能占用调度线程等待飞书。 */
export const DELIVERY_TIMEOUT_MS = 10_000;
/** 文件配置与直接构建应用的测试配置经过相同检查。 */
export function validateIntegrationConfig(
  value: IntegrationConfig | undefined,
  reserved: string[],
): void {
  if (!value) return;
  if (!Array.isArray(value.clients) || !Array.isArray(value.connections))
    throw new Error('Invalid integration configuration');
  const ids = new Set<string>();
  const tokens = new Set(reserved);
  const credential = (token: string) => {
    if (
      typeof token !== 'string' ||
      token.length < 32 ||
      token.length > 500 ||
      tokens.has(token)
    )
      throw new Error(
        'Integration credentials must be distinct and at least 32 characters',
      );
    tokens.add(token);
  };
  for (const connection of value.connections) {
    const url = new URL(connection.url);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    )
      throw new Error('Integration URL must be an HTTP(S) origin');
    if (!connection.id || ids.has(connection.id))
      throw new Error('Duplicate integration id');
    ids.add(connection.id);
    credential(connection.deliveryToken);
    credential(connection.viewToken);
    const refs = new Set<string>();
    for (const binding of connection.bindings) {
      if (
        !binding.ref ||
        binding.ref.length > 200 ||
        refs.has(binding.ref) ||
        !Number.isSafeInteger(binding.version) ||
        binding.version < 1
      )
        throw new Error('Invalid integration binding');
      refs.add(binding.ref);
    }
  }
  ids.clear();
  for (const client of value.clients) {
    credential(client.token);
    const connection = value.connections.find(
      (item) => item.id === client.integrationId,
    );
    if (
      !client.id ||
      ids.has(client.id) ||
      !connection ||
      !client.bindingRefs.includes(client.defaultBindingRef) ||
      client.bindingRefs.some(
        (ref) => !connection.bindings.some((b) => b.ref === ref),
      )
    )
      throw new Error('Invalid integration client binding');
    ids.add(client.id);
  }
}
/** 未设置文件时保持原有管理入口，MCP 和集成入口不启用。 */
export function loadIntegrationConfig(
  file: string | undefined,
): IntegrationConfig | undefined {
  if (!file) return undefined;
  const value = JSON.parse(readFileSync(file, 'utf8'));
  const token = (row: Record<string, any>, key: string) => {
    const fileKey = `${key}File`;
    if (row[key] && row[fileKey])
      throw new Error('Configure either token or token file');
    if (row[fileKey])
      row[key] = readFileSync(
        resolve(dirname(file), row[fileKey]),
        'utf8',
      ).trim();
    delete row[fileKey];
  };
  for (const connection of value.connections ?? []) {
    token(connection, 'deliveryToken');
    token(connection, 'viewToken');
  }
  for (const client of value.clients ?? []) token(client, 'token');
  return value;
}
/** 使用常量时间的摘要比较；不允许管理员令牌充当集成调用者。 */
export function authenticateClient(
  config: IntegrationConfig,
  header: string | undefined,
): IntegrationClient {
  for (const client of config.clients) {
    try {
      requireToken(header, client.token);
      return client;
    } catch {
      /* 继续检查其他独立调用者。 */
    }
  }
  throw new ApiError(401, 'UNAUTHORIZED', 'Invalid integration credential');
}
