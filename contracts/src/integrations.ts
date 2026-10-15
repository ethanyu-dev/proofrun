import { readFileSync } from 'node:fs';
import { Ajv, type ValidateFunction } from 'ajv';
import formatsPlugin from 'ajv-formats';
import type { IntegrationSubmit } from './generated/integration-submit.js';
import type { NotificationEvent } from './generated/notification-event.js';
import type { NotificationView } from './generated/notification-view.js';
import type { NotificationReceipt } from './generated/notification-receipt.js';
export type {
  IntegrationSubmit,
  NotificationEvent,
  NotificationView,
  NotificationReceipt,
};

/** 展开本地契约引用；对外工具无需知道 ProofRun 的文件路径与 schema 注册表。 */
function expand(value: any): any {
  if (Array.isArray(value)) return value.map(expand);
  if (!value || typeof value !== 'object') return value;
  if (value.$ref) {
    const [file, pointer] = value.$ref.split('#');
    let target = read(file);
    if (pointer)
      for (const key of pointer.slice(1).split('/')) target = target[key];
    return expand(target);
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !['$id', '$schema'].includes(key))
      .map(([key, item]) => [key, expand(item)]),
  );
}
/** 文件名仅来自随包发布的契约，调用方不能传入路径。 */
function read(file: string): any {
  return JSON.parse(
    readFileSync(new URL(`../schemas/${file}`, import.meta.url), 'utf8'),
  );
}
const ajv = new Ajv({ allErrors: true, strict: true });
formatsPlugin.default(ajv);
/** 每个工具公开的输入、输出与运行时校验使用同一契约。 */
export const mcpToolSchemas: Record<
  string,
  { inputSchema: any; outputSchema: any }
> = expand(read('mcp-tools.json'));
export const mcpInputValidators: Record<
  string,
  ValidateFunction<any>
> = Object.fromEntries(
  Object.entries(mcpToolSchemas).map(([name, schema]) => [
    name,
    ajv.compile(schema.inputSchema),
  ]),
);
export const mcpOutputValidators: Record<
  string,
  ValidateFunction<any>
> = Object.fromEntries(
  Object.entries(mcpToolSchemas).map(([name, schema]) => [
    name,
    ajv.compile(schema.outputSchema),
  ]),
);
export const validateIntegrationSubmit = ajv.compile<IntegrationSubmit>(
  expand(read('integration-submit.schema.json')),
);
export const validateNotificationEvent = ajv.compile<NotificationEvent>(
  expand(read('notification-event.schema.json')),
);
export const validateNotificationView = ajv.compile<NotificationView>(
  expand(read('notification-view.schema.json')),
);
export const validateNotificationReceipt = ajv.compile<NotificationReceipt>(
  expand(read('notification-receipt.schema.json')),
);
