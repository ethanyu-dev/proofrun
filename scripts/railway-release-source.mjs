import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, copyFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBenchmark } from '../contracts/dist/benchmark.js';
import { verifyRelease } from './benchmarks/release-gate.mjs';
import { ROOT, sourceFingerprint } from './benchmarks/source.mjs';

const execute = promisify(execFile);
/** 只接受本仓库 main 的完整 CI 成功结果，不能使用 PR、独立基准作业或过时提交。 */
export function verifyReleaseCI(run, repository, commit) {
  if (
    !/^[a-f0-9]{40}$/.test(commit) ||
    !Number.isSafeInteger(run.id) ||
    run.id < 1 ||
    !Number.isSafeInteger(run.run_attempt) ||
    run.run_attempt < 1 ||
    run.repository?.full_name !== repository ||
    run.head_repository?.full_name !== repository ||
    run.head_sha !== commit ||
    run.head_branch !== 'main' ||
    run.event !== 'push' ||
    run.path !== '.github/workflows/ci.yml' ||
    run.status !== 'completed' ||
    run.conclusion !== 'success'
  )
    throw new Error('发布被阻止：必须使用当前 main 提交的完整成功 CI');
}
/** 干净归档只包含受版本管理的源码和本次 CI 报告，不上传工作区凭据、日志或旧结果。 */
export async function prepareReleaseSource({
  ci,
  repository,
  commit,
  report,
  root = ROOT,
}) {
  verifyReleaseCI(ci, repository, commit);
  const temporary = await mkdtemp(join(tmpdir(), 'proofrun-release-'));
  try {
    const directory = join(temporary, 'source');
    await mkdir(directory);
    const archive = join(temporary, 'source.tar');
    await execute(
      'git',
      ['archive', '--format=tar', '--output', archive, commit],
      { cwd: root },
    );
    await execute('tar', ['-xf', archive, '-C', directory]);
    const run = parseBenchmark(await readFile(report, 'utf8'));
    // 只重跑失败作业时，已成功的真实基准可能来自同一 CI 的较早尝试；仍核对提交、指纹和原有效期。
    const build = /^ci-(\d+)-(\d+)$/.exec(run.release?.buildId ?? '');
    if (
      run.origin !== 'ci' ||
      run.release?.commit !== commit ||
      run.source.revision !== commit ||
      !build ||
      build[1] !== String(ci.id) ||
      Number(build[2]) < 1 ||
      Number(build[2]) > ci.run_attempt
    )
      throw new Error('发布被阻止：报告不是该 CI 作业与提交生成');
    verifyRelease(run, await sourceFingerprint(directory));
    await mkdir(join(directory, '.benchmark-release'), { recursive: true });
    await copyFile(report, join(directory, '.benchmark-release', 'real.json'));
    return { temporary, directory, release: run.release };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}
