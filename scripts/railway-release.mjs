import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { railwayGraphqlFailure } from './railway-errors.mjs';
import { retainReleaseBackups } from './railway-backups.mjs';
import {
  prepareReleaseSource,
  verifyReleaseCI,
} from './railway-release-source.mjs';

/** API 先完成迁移并就绪，再更新 Agent 和 Web；各步失败立即停止。 */
const SERVICES = ['api', 'agent', 'web'];
const POLL_MS = 10000;
const DEPLOY_MS = 20 * 60_000;
const execute = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** CLI 输出只在内存解析，错误不透传可能含变量值的 stdout/stderr。 */
async function command(binary, args) {
  try {
    return (
      await execute(binary, args, {
        timeout: 120000,
        maxBuffer: 32 * 1024 * 1024,
      })
    ).stdout;
  } catch {
    throw new Error(`${binary} ${args[0]} 失败，请检查该步骤的权限及平台状态`);
  }
}
/** 显式定位环境；不依赖本机 link，也不读取或输出个人 Railway token。 */
export async function releaseRailway(
  { repository, runId, project, environment, prepareOnly = false },
  {
    run = command,
    prepare = prepareReleaseSource,
    fetchJson = fetch,
    wait = sleep,
  } = {},
) {
  if (!repository || !/^\d+$/.test(runId ?? '') || !project || !environment)
    throw new Error('需要 repository、run、project 和 environment');
  const ci = JSON.parse(
    await run('gh', ['api', `repos/${repository}/actions/runs/${runId}`]),
  );
  const commit = (await run('git', ['rev-parse', 'HEAD'])).trim();
  verifyReleaseCI(ci, repository, commit);
  const head = JSON.parse(
    await run('gh', ['api', `repos/${repository}/commits/main`]),
  );
  if (head.sha !== commit)
    throw new Error('发布被阻止：main 已有更新提交，请等待对应 CI');
  const download = await mkdtemp(join(tmpdir(), 'proofrun-ci-report-'));
  let prepared;
  const railway = async (args) => {
    const output = await run('railway', args);
    try {
      return JSON.parse(output);
    } catch {
      throw new Error('Railway 返回无效 JSON，停止发布');
    }
  };
  const graphql = async (stage, query, variables) => {
    console.log(`Railway：${stage}`);
    let result;
    try {
      result = await railway([
        'api',
        query,
        '--variables',
        JSON.stringify(variables),
        '--compact',
        '--allow-errors',
      ]);
    } catch {
      throw new Error(
        `Railway ${stage}：命令或响应读取失败，停止发布；未自动重放写操作`,
      );
    }
    if (result.errors?.length)
      throw railwayGraphqlFailure(stage, result.errors);
    if (!result.data)
      throw new Error(`Railway ${stage}：响应缺少 data，停止发布`);
    return result.data;
  };
  const target = ['--project', project, '--environment', environment];
  try {
    try {
      await run('gh', [
        'run',
        'download',
        runId,
        '--repo',
        repository,
        '--name',
        'real-agent-benchmark-release',
        '--dir',
        download,
      ]);
    } catch {
      throw new Error(
        '发布被阻止：当前 CI 的真实报告缺失或已过期，请重新运行完整 CI',
      );
    }
    prepared = await prepare({
      ci,
      repository,
      commit,
      report: join(download, 'real.json'),
    });
    console.log(`发布包已校验：${prepared.release.version} / ${commit}`);
    if (prepareOnly)
      return { directory: prepared.directory, release: prepared.release };
    const variables = await railway([
      'variable',
      'list',
      ...target,
      '--service',
      'api',
      '--json',
    ]);
    const base = new URL(variables.PROOFRUN_PUBLIC_URL);
    if (base.protocol !== 'https:' || !variables.PROOFRUN_ADMIN_TOKEN)
      throw new Error('缺少生产 HTTPS 地址或管理员凭据');
    const request = async (path, auth = true) => {
      const response = await fetchJson(new URL(path, base), {
        headers: auth
          ? { authorization: `Bearer ${variables.PROOFRUN_ADMIN_TOKEN}` }
          : {},
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(`发布检查 HTTP ${response.status}`);
      return response.json();
    };
    const idle = async () => {
      for (const state of ['QUEUED', 'RUNNING']) {
        const result = await request(`/v1/tasks?state=${state}&limit=1`);
        if (
          !Array.isArray(result.tasks) ||
          result.tasks.length ||
          result.nextCursor
        )
          throw new Error(
            '发布被阻止：仍有排队或运行任务，待结束后重跑发布作业',
          );
      }
    };
    await idle();
    const data = await graphql(
      '查询生产环境持久卷',
      'query($project:String!){ project(id:$project){ environments { edges { node { id name volumeInstances { edges { node { id service { name } deletedAt } } } } } } } }',
      { project },
    );
    const selected = data.project.environments.edges
      .map(({ node }) => node)
      .filter((node) => node.id === environment || node.name === environment);
    if (selected.length !== 1) throw new Error('部署环境不唯一');
    const volumes = selected[0].volumeInstances.edges.map(({ node }) => node);
    for (const service of ['api', 'Postgres']) {
      const matches = volumes.filter(
        (volume) => !volume.deletedAt && volume.service.name === service,
      );
      if (matches.length !== 1)
        throw new Error(`缺少 ${service} 唯一持久卷，停止发布`);
      const volume = matches[0];
      const backupName = `ci-${runId}-${ci.run_attempt}`;
      const list = async () =>
        (
          await graphql(
            `${service} 查询备份`,
            'query($id:String!){ volumeInstanceBackupList(volumeInstanceId:$id){ id name createdAt } }',
            { id: volume.id },
          )
        ).volumeInstanceBackupList;
      const existing = await retainReleaseBackups(
        {
          service,
          backupName,
          list,
          remove: async (backupId) => {
            const result = await graphql(
              `${service} 删除过期备份`,
              'mutation($id:String!,$backupId:String!){ volumeInstanceBackupDelete(volumeInstanceId:$id,volumeInstanceBackupId:$backupId){ workflowId } }',
              { id: volume.id, backupId },
            );
            if (!result.volumeInstanceBackupDelete?.workflowId)
              throw new Error(`${service} 备份删除回执缺失，停止发布`);
          },
        },
        { wait },
      );
      console.log(
        `${service} 当前备份数：${existing.length}；目标备份：${backupName}`,
      );
      if (!existing.some((backup) => backup.name === backupName)) {
        await graphql(
          `${service} 创建发布前备份`,
          'mutation($id:String!,$name:String!){ volumeInstanceBackupCreate(volumeInstanceId:$id,name:$name){ workflowId } }',
          { id: volume.id, name: backupName },
        );
        const deadline = Date.now() + DEPLOY_MS;
        while (!(await list()).some((backup) => backup.name === backupName)) {
          if (Date.now() >= deadline)
            throw new Error(`${service} 备份未完成，停止发布`);
          await sleep(POLL_MS);
        }
      }
      console.log(`${service} 升级前备份已确认`);
    }
    for (const service of SERVICES) {
      await idle();
      const deployment = await railway([
        'up',
        prepared.directory,
        '--path-as-root',
        '--no-gitignore',
        ...target,
        '--service',
        service,
        '--detach',
        '--json',
        '--message',
        `CI ${runId} / ${commit}`,
      ]);
      if (!deployment.deploymentId)
        throw new Error(`${service} 上传没有返回部署身份`);
      console.log(`${service}: ${deployment.deploymentId}`);
      const deadline = Date.now() + DEPLOY_MS;
      for (;;) {
        const list = await railway([
          'deployment',
          'list',
          ...target,
          '--service',
          service,
          '--limit',
          '10',
          '--json',
        ]);
        const current = list.find(
          (item) => item.id === deployment.deploymentId,
        );
        if (current?.status === 'SUCCESS') break;
        if (
          ['FAILED', 'CRASHED', 'REMOVED', 'SKIPPED'].includes(
            current?.status,
          ) ||
          Date.now() >= deadline
        )
          throw new Error(
            `${service} 部署未成功：${deployment.deploymentId} (${current?.status ?? '未找到'})`,
          );
        await sleep(POLL_MS);
      }
      if (
        service === 'api' &&
        (await request('/v1/admin/benchmarks/status')).release.commit !== commit
      )
        throw new Error('API 实际版本与发布提交不同');
      if (
        service === 'web' &&
        (await request(`/build-info.json?commit=${commit}`, false)).commit !==
          commit
      )
        throw new Error('Web 实际版本与发布提交不同');
      console.log(`${service} 部署成功`);
    }
  } finally {
    await rm(download, { recursive: true, force: true });
    if (prepared && !prepareOnly)
      await rm(prepared.temporary, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values } = parseArgs({
    options: {
      repository: { type: 'string' },
      run: { type: 'string' },
      project: { type: 'string' },
      environment: { type: 'string' },
      'prepare-only': { type: 'boolean', default: false },
    },
  });
  await releaseRailway({
    repository: values.repository,
    runId: values.run,
    project: values.project,
    environment: values.environment,
    prepareOnly: values['prepare-only'],
  })
    .then((value) => {
      if (value) console.log(JSON.stringify(value));
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
