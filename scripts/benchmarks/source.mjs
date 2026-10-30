import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 源码指纹不依赖 Git 或平台，镜像构建也必须匹配本次实际测试的源文件。 */
export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SOURCE_ROOTS = [
  '.github',
  'apps',
  'packages',
  'contracts',
  'crates',
  'scripts',
  'tests',
  'deploy',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'Cargo.toml',
  'Cargo.lock',
  'rust-toolchain.toml',
  'tsconfig.base.json',
];
const OMIT = new Set([
  'node_modules',
  'dist',
  'target',
  '__pycache__',
  '.DS_Store',
]);

/** 只忽略生成目录；任何运行代码、提示词、场景、配置或依赖锁变动都会使旧报告失效。 */
export async function sourceFingerprint(root = ROOT) {
  const hash = createHash('sha256');
  async function visit(relative) {
    const path = resolve(root, relative);
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch (error) {
      if (error.code !== 'ENOTDIR') throw error;
      hash.update(relative + '\0');
      hash.update(await readFile(path));
      hash.update('\0');
      return;
    }
    for (const entry of entries.sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      if (OMIT.has(entry.name) || entry.name.endsWith('.pyc')) continue;
      if (entry.isSymbolicLink())
        throw new Error(`源码目录不支持符号链接：${relative}/${entry.name}`);
      await visit(`${relative}/${entry.name}`);
    }
  }
  for (const name of SOURCE_ROOTS) await visit(name);
  return hash.digest('hex');
}
