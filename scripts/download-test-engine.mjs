import { createHash } from 'node:crypto';
import { mkdir, readFile, mkdtemp, chmod, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** 测试只使用已核对的原生版本；摘要来自该版本 GitHub Release 的资产元数据。 */
const VERSION = '0.38.1';
const SHA256 = {
  x64: '5100149a1903211c889de4e545bf36d90803740cea4f99aa22651649f9205ea1',
  arm64: '937b315ee0761e8a62f7950ddcfef9b3d3d8e8d5eb9c9d2bf9e23e5725664511',
};
/** 限制下载等待和文件大小，避免 CI 无限挂起或写入异常资产。 */
const TIMEOUT_MS = 120_000;
const MAX_BYTES = 64 * 1024 * 1024;
/** 使用系统 curl 的 HTTPS 传输与代理设置，参数直接传递，不经过 shell。 */
const download = promisify(execFile);
const [arch, output] = process.argv.slice(2);
if (!Object.hasOwn(SHA256, arch ?? '') || !output)
  throw new Error(
    '用法：node scripts/download-test-engine.mjs <x64|arm64> <输出路径>',
  );
const target = resolve(output);
/** 固定摘要验证整个文件，不能以文件名或下载成功代替版本核对。 */
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const existing = await readFile(target).catch((error) => {
  if (error.code !== 'ENOENT') throw error;
  return null;
});
if (existing) {
  if (digest(existing) !== SHA256[arch])
    throw new Error('已有文件摘要不匹配，请使用新的测试输出路径');
} else {
  await mkdir(dirname(target), { recursive: true });
  const staging = await mkdtemp(`${target}.download-`);
  const temporary = resolve(staging, 'engine');
  try {
    await download(
      'curl',
      [
        '--fail',
        '--location',
        '--silent',
        '--show-error',
        '--proto',
        '=https',
        '--proto-redir',
        '=https',
        '--connect-timeout',
        '15',
        '--max-time',
        String(TIMEOUT_MS / 1000),
        '--max-filesize',
        String(MAX_BYTES),
        '--output',
        temporary,
        `https://github.com/vercel-labs/agent-browser/releases/download/v${VERSION}/agent-browser-linux-${arch}`,
      ],
      { timeout: TIMEOUT_MS + 5000 },
    );
    const bytes = await readFile(temporary);
    if (bytes.length > MAX_BYTES || digest(bytes) !== SHA256[arch])
      throw new Error('引擎资产大小或 SHA-256 不匹配');
    await rename(temporary, target);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
await chmod(target, 0o755);
console.log(`agent-browser ${VERSION} linux-${arch} SHA-256 已核实：${target}`);
