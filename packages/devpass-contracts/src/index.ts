import { Ajv, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import getInput from './schemas/get-account-input.json' with { type: 'json' };
import getOutput from './schemas/get-account-output.json' with { type: 'json' };
import releaseInput from './schemas/release-account-input.json' with { type: 'json' };
import releaseOutput from './schemas/release-account-output.json' with { type: 'json' };
import material from './schemas/material.json' with { type: 'json' };
import payload from './schemas/material-payload.json' with { type: 'json' };
export type * from './generated/get-account-input.js';
export type * from './generated/get-account-output.js';
export type * from './generated/release-account-input.js';
export type * from './generated/release-account-output.js';
export type * from './generated/material.js';
export type * from './generated/material-payload.js';

/** 契约同时用于 MCP 发布与本地校验；不使用会悄悄修改请求的类型转换。 */
export const schemas = {
  getInput,
  getOutput,
  releaseInput,
  releaseOutput,
  material,
  payload,
};
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats.default(ajv);
export const validators = Object.fromEntries(
  Object.entries(schemas).map(([key, schema]) => [key, ajv.compile(schema)]),
) as Record<keyof typeof schemas, ValidateFunction>;

/** 只返回字段路径，不把包含凭据的输入值复制到错误信息中。 */
export function validate(name: keyof typeof schemas, value: unknown): void {
  const validator = validators[name];
  if (!validator(value))
    throw new Error(
      '参数不符合契约：' + (validator.errors?.[0]?.instancePath || '/'),
    );
}

/** 使用 URL 标准化源，拒绝被解析器悄悄消除的路径、凭据和片段。 */
export function normalizeOrigin(input: string, allowLoopback = false): string {
  if (input !== input.trim() || /[\\\s]/u.test(input))
    throw new Error('地址必须是有效的 origin');
  const url = new URL(input);
  if (
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    input.includes('?') ||
    input.includes('#')
  )
    throw new Error('origin 不允许路径、凭据、查询参数或片段');
  // 原始路径只允许空或根路径，防止 /a/../ 被 URL 解析器归一化后绕过约束。
  if (!/^https?:\/\/[^/]+\/?$/iu.test(input))
    throw new Error('origin 不能包含业务路径');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    url.protocol !== 'https:' &&
    !(allowLoopback && loopback && url.protocol === 'http:')
  )
    throw new Error('origin 必须使用 HTTPS');
  return url.origin;
}

/** 标签是集合；去除空白后拒绝空标签，不做权限语义推断。 */
export function normalizeTags(tags: string[]): string[] {
  const values = tags.map((value) => value.trim());
  if (values.some((value) => !value)) throw new Error('标签不能为空');
  return [...new Set(values)].sort();
}

/** 补充 JSON Schema 无法表达的跨字段范围、重复键与浏览器属性限制。 */
export function validateMaterial(value: unknown, origin: string): void {
  validate('material', value);
  if (new TextEncoder().encode(JSON.stringify(value)).length > 65536)
    throw new Error('材料超过 64 KiB');
  const data = value as import('./generated/material.js').Material;
  const keys = new Set<string>();
  if (data.type === 'http_bearer' && /[\r\n\s]/u.test(data.access_token))
    throw new Error('Bearer token 不允许空白');
  if (data.type === 'browser_cookies')
    for (const cookie of data.cookies) {
      // Cookie 名称使用 HTTP token 字符；值不能携带控制字符或属性分隔符。
      if (
        !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(cookie.name) ||
        /[\x00-\x20\x7f;,]/u.test(cookie.value)
      )
        throw new Error('Cookie 名称或值无效');
      if (cookie.domain !== new URL(origin).hostname || !cookie.host_only)
        throw new Error('Cookie 超出账号 origin');
      if (
        (cookie.same_site === 'None' ||
          cookie.name.startsWith('__Secure-') ||
          cookie.name.startsWith('__Host-')) &&
        !cookie.secure
      )
        throw new Error('Cookie 必须启用 Secure');
      if (cookie.name.startsWith('__Host-') && cookie.path !== '/')
        throw new Error('__Host- Cookie 必须使用根路径');
      if (/[\x00-\x1f\x7f;]/u.test(cookie.path))
        throw new Error('Cookie 路径无效');
      const key = JSON.stringify([cookie.name, cookie.domain, cookie.path]);
      if (keys.has(key)) throw new Error('Cookie 重复');
      keys.add(key);
    }
  if (data.type === 'browser_storage')
    for (const entry of data.entries) {
      const key = JSON.stringify([entry.storage, entry.key]);
      if (keys.has(key)) throw new Error('存储条目重复');
      keys.add(key);
    }
}
