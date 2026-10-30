import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT } from './source.mjs';

/** 与生产宿主固定版本保持一致；npm pack 通过注册表完整性校验后只提取本机原生资产。 */
const VERSION = '0.38.1';
const platform = `${process.platform}-${process.arch}`;
if (
  !['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'].includes(platform)
)
  throw new Error('真实浏览器基准目前支持 macOS / Linux');
const temp = await mkdtemp(join(tmpdir(), 'proofrun-benchmark-engine-'));
try {
  execFileSync(
    'npm',
    [
      'pack',
      `agent-browser@${VERSION}`,
      '--pack-destination',
      temp,
      '--silent',
    ],
    { stdio: 'pipe', timeout: 120000 },
  );
  const binary = execFileSync(
    'tar',
    [
      '-xOf',
      join(temp, `agent-browser-${VERSION}.tgz`),
      `package/bin/agent-browser-${platform}`,
    ],
    { maxBuffer: 100 * 1024 * 1024 },
  );
  const output = resolve(ROOT, `.proofrun/bin/agent-browser-${platform}`);
  await mkdir(resolve(ROOT, '.proofrun/bin'), { recursive: true });
  await writeFile(output, binary, { mode: 0o755 });
  console.log(execFileSync(output, ['--version'], { encoding: 'utf8' }).trim());
  console.log(
    `原生引擎已准备：${output}；Chrome 使用本机安装或 PROOFRUN_CHROME_BIN。`,
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
