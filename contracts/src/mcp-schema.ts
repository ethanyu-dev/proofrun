import { readFileSync } from 'node:fs';
/** 固定仓库 Schema 的只读展开，供两套工具目录生成自包含契约。 */
type Schema = Record<string, any>;
/** 读取固定契约文件；不接受调用方提供的文件地址。 */
export function read(url: URL): Schema {
  return JSON.parse(readFileSync(url, 'utf8'));
}
/** 只展开仓库内固定契约的引用；调用方输入不会成为文件地址。 */
export function expand(value: any, base: URL): any {
  if (Array.isArray(value)) return value.map((item) => expand(item, base));
  if (!value || typeof value !== 'object') return value;
  if (value.$ref) {
    const url = new URL(value.$ref, base);
    const fragment = url.hash;
    url.hash = '';
    let target = read(url);
    if (fragment)
      for (const part of fragment.slice(2).split('/'))
        target = target[part.replaceAll('~1', '/').replaceAll('~0', '~')];
    return expand(target, url);
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !['$id', '$schema'].includes(key))
      .map(([key, item]) => [key, expand(item, base)]),
  );
}
