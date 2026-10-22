import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  open,
  unlink,
} from 'node:fs/promises';
import { join } from 'node:path';

/** 身份仅用作单层目录名，禁止恢复入口越过本批次目录。 */
export const ID = /^[A-Za-z0-9_-]{1,80}$/;
export const FORMAT_VERSION = 1;

/** 递归排序对象键；数组顺序属于场景和冻结配置的语义。 */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

/** 摘要只用于材料身份和配置比较，不证明业务事实。 */
export function digest(value) {
  return createHash('sha256')
    .update(
      typeof value === 'string' || Buffer.isBuffer(value)
        ? value
        : canonical(value),
    )
    .digest('hex');
}

/** 同目录原子替换，恢复时不会把半份 JSON 当作提交身份或最终判定。 */
export async function save(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  const file = await open(temp, 'wx', 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temp, path);
}

/** 缺失与损坏分开处理；损坏文件不能自动覆盖。 */
export async function read(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

/** 排他锁防止两个编排器同时提交；崩溃留下锁时必须先确认旧进程退出。 */
export async function lock(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'runner.lock');
  const file = await open(path, 'wx', 0o600);
  await file.writeFile(
    JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
  );
  return async () => {
    await file.close();
    await unlink(path);
  };
}

/** 原始二进制材料不经过 JSON 转换；文件名由已校验的证据 ID 生成。 */
export async function saveBytes(path, bytes) {
  await writeFile(path, bytes, { mode: 0o600 });
}
