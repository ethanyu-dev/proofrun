import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

/** 只修复应用服务的路径过滤，不修改数据库或其他服务。 */
const APPLICATIONS = ['api', 'web', 'agent'];
/** 只读取定位服务和比较策略需要的字段，避免获取环境变量和密钥。 */
const PROJECT_QUERY = `query WatchPaths($project: String!) {
  project(id: $project) {
    id name
    environments { edges { node {
      id name
      serviceInstances { edges { node { serviceId serviceName watchPatterns } } }
    } } }
  }
}`;
/** CLI 进程必须有界，参数通过数组传递，不让项目名进入 shell 求值。 */
const execute = promisify(execFile);
const CLI_TIMEOUT_MS = 60_000;

/** 使用已登录的 Railway CLI；不读取或输出本机登录令牌。 */
async function railway(args) {
  const { stdout } = await execute('railway', args, {
    timeout: CLI_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout);
}

/** 默认只预览；暂存时使用环境级配置接口，交由操作者审阅后发布。 */
export async function repairWatchPaths(
  { projectId, environment, stage = false },
  run = railway,
) {
  if (!projectId || !environment)
    throw new Error(
      '必须显式指定 --project 项目 ID 和 --environment 环境名称或 ID',
    );
  const response = await run([
    'api',
    PROJECT_QUERY,
    '--variables',
    JSON.stringify({ project: projectId }),
    '--compact',
  ]);
  const project = response.data?.project;
  if (response.errors?.length || !project || project.id !== projectId)
    throw new Error('无法读取指定 Railway 项目，未暂存任何配置');
  const environments = project.environments.edges
    .map(({ node }) => node)
    .filter((node) => node.id === environment || node.name === environment);
  if (environments.length !== 1)
    throw new Error('目标环境不存在或不唯一，未暂存任何配置');
  const selected = environments[0];
  const instances = selected.serviceInstances.edges.map(({ node }) => node);
  // 必须先验证三个服务全部存在，避免名称变化时只修复一部分服务。
  const services = APPLICATIONS.map((name) => {
    const matches = instances.filter((node) => node.serviceName === name);
    if (
      matches.length !== 1 ||
      !matches[0].serviceId ||
      !Array.isArray(matches[0].watchPatterns)
    )
      throw new Error(
        `服务 ${name} 缺失、重复或监听配置不可读，未暂存任何配置`,
      );
    return {
      id: matches[0].serviceId,
      name,
      before: matches[0].watchPatterns,
      after: [],
    };
  });
  const changes = services.filter((service) => service.before.length > 0);
  if (stage && changes.length) {
    // --stage 不提交已有待发布变更；平台页面仍须审阅整个变更集并选择发布版本。
    await run([
      'environment',
      'edit',
      '--project',
      project.id,
      '--environment',
      selected.id,
      ...changes.flatMap((service) => [
        '--service-config',
        service.id,
        'build.watchPatterns',
        '[]',
      ]),
      '--stage',
      '--json',
    ]);
  }
  return {
    project: { id: project.id, name: project.name },
    environment: { id: selected.id, name: selected.name },
    services,
    staged: stage && changes.length > 0,
    message:
      stage && changes.length > 0
        ? '已暂存清空 Watch Paths 的变更；需在 Railway 审阅并发布，尚未更新运行版本。'
        : changes.length
          ? '发现路径过滤；使用 --stage 可暂存修复。'
          : '当前已关闭路径过滤，无需变更。',
  };
}

/** 直接调用才解析 CLI；导入测试不会读取 Railway 或暂存生产配置。 */
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const { values } = parseArgs({
      options: {
        project: { type: 'string' },
        environment: { type: 'string' },
        stage: { type: 'boolean', default: false },
      },
    });
    console.log(
      JSON.stringify(
        await repairWatchPaths({
          projectId: values.project,
          environment: values.environment,
          stage: values.stage,
        }),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
