import assert from 'node:assert/strict';
import { spawn, execFileSync, execFile } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { buildApp } from '../../apps/api/dist/app.js';
import { createSite } from './site.mjs';
import { transcriptFacts, verifyAudit } from './audit.mjs';

/** 显式运行的真实模型测试，不进入无凭据的常规单元测试。所有资源都有独立身份。 */
const ROOT = resolve(import.meta.dirname, '../..');
const CONTAINER =
  process.env.PROOFRUN_REAL_CONTAINER ?? 'proofrun-preview-runtime-1';
const API_PORT = Number(process.env.PROOFRUN_REAL_API_PORT ?? 4141);
const SITE_PORT = Number(process.env.PROOFRUN_REAL_SITE_PORT ?? 4142);
const API = `http://127.0.0.1:${API_PORT}`;
const SITE = `http://host.docker.internal:${SITE_PORT}`;
const CLI =
  process.env.PROOFRUN_CODEX_BIN ??
  process.env.CODEX_APP_RUNTIME_CLI_PATH ??
  'codex';
const NODE =
  process.env.PROOFRUN_REAL_NODE_BIN ??
  '/target/mcp-real-current/debug/proofrun-node';
const ENGINE =
  process.env.PROOFRUN_REAL_ENGINE_BIN ??
  '/var/lib/proofrun/releases/node-v0.1.0-alpha.9/bin/agent-browser';
const id = randomUUID().replaceAll('-', '');
const directory = join(ROOT, '.proofrun/mcp-real', id);
const containerHome = `/var/lib/proofrun/mcp-real-${id}`;
const database = `proofrun_mcp_real_${id}`;
const require = createRequire(
  new URL('../../apps/api/package.json', import.meta.url),
);
const { Pool } = require('pg');
const admin = new Pool({
  connectionString:
    process.env.PROOFRUN_TEST_DATABASE_URL ??
    'postgresql://mac@127.0.0.1:5432/postgres',
});
const processes = [];
const children = [];
const tokens = Object.fromEntries(
  ['admin', 'worker', 'browser', 'verification'].map((key) => [
    key,
    randomBytes(32).toString('hex'),
  ]),
);

/** 参数数组直接传递，凭据只写私有文件或环境，绝不插入 shell 或命令行。 */
function docker(args, input) {
  return execFileSync(
    'docker',
    ['exec', ...(input ? ['-i'] : []), CONTAINER, ...args],
    { input, encoding: 'utf8' },
  );
}
/** 只管理本次宿主创建的子进程；日志保存到忽略目录用于诊断。 */
function start(command, args, log, env = process.env) {
  const fd = openSync(join(directory, log), 'a', 0o600);
  const child = spawn(command, args, {
    cwd: directory,
    env,
    stdio: ['pipe', fd, fd],
  });
  closeSync(fd);
  children.push(child);
  return child;
}
/** 等待外部事实变化，超时保留最后状态供诊断。 */
async function until(read, accept, timeout = 60000) {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (accept(value)) return value;
    await delay(300);
  }
  throw new Error(`状态等待超时：${JSON.stringify(value)}`);
}
/** 管理凭据仅用于准备节点和验收读取，不参与 Case 的模型执行。 */
async function management(method, path, body) {
  const response = await fetch(API + path, {
    method,
    headers: {
      authorization: `Bearer ${tokens.admin}`,
      'content-type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  assert.ok(response.ok, JSON.stringify(data));
  return data;
}

await mkdir(directory, { recursive: true, mode: 0o700 });
await writeFile(join(ROOT, '.proofrun/mcp-real/latest'), directory + '\n');
let app, db, site;
try {
  // 默认构建当前源码到专用目录，不替换容器现有服务使用的二进制。
  if (!process.env.PROOFRUN_REAL_NODE_BIN) {
    const build = start(
      'docker',
      [
        'exec',
        '-w',
        '/workspace',
        '-e',
        'PATH=/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        CONTAINER,
        '/usr/local/cargo/bin/cargo',
        'build',
        '--locked',
        '--offline',
        '-p',
        'proofrun-node',
        '--target-dir',
        '/target/mcp-real-current',
      ],
      'node-build.log',
    );
    const [code] = await once(build, 'exit');
    assert.equal(code, 0, '当前节点构建失败，查看 node-build.log');
  }
  const versions = {
    codex: execFileSync(CLI, ['--version'], { encoding: 'utf8' }).trim(),
    node: JSON.parse(docker([NODE, 'build-info'])),
    engine: docker([ENGINE, '--version']).trim(),
    chromium: docker(['/usr/bin/chromium', '--version']).trim(),
    model: process.env.PROOFRUN_CODEX_MODEL ?? 'Codex 默认模型',
  };
  await writeFile(
    join(directory, 'versions.json'),
    JSON.stringify(versions, null, 2),
  );
  await admin.query(`CREATE DATABASE ${database}`);
  const url = new URL(admin.options.connectionString);
  url.pathname = `/${database}`;
  db = new Pool({ connectionString: url.toString() });
  const credentials = ['browser', 'verification'].map((channel) => ({
    principalId: `codex-${id}`,
    channels: [channel],
    tokenSha256: createHash('sha256').update(tokens[channel]).digest('hex'),
    scopes: [
      'browser:control',
      'verification:control',
      'verification:submit',
      'runs:read',
      'evidence:read',
      'runs:cancel',
    ],
  }));
  await writeFile(
    join(directory, 'credentials.json'),
    JSON.stringify(credentials, null, 2),
    { mode: 0o600 },
  );
  app = await buildApp(
    {
      databaseUrl: url.toString(),
      adminToken: tokens.admin,
      workerToken: tokens.worker,
      publicUrl: API,
      host: '0.0.0.0',
      port: API_PORT,
      artifactDirectory: join(directory, 'artifacts'),
      workerLeaseMs: 15000,
      nodeLeaseMs: 20000,
      tickMs: 250,
      executionRuntimeVersion: 1,
      publicCredentials: credentials,
      caseProfile: {
        environment: {
          id: 'codex-real',
          nodePool: `mcp-real-${id}`,
          allowIntervention: true,
        },
        budget: { timeoutMs: 3600000, maxActions: 40 },
        executionMode: 'llm',
        evidenceKinds: ['DOM', 'SCREENSHOT'],
      },
    },
    { logger: false },
  );
  await app.listen({ host: '0.0.0.0', port: API_PORT });
  site = createSite();
  await new Promise((resolve) =>
    site.server.listen(SITE_PORT, '0.0.0.0', resolve),
  );
  docker(['mkdir', '-p', containerHome]);
  const config = `home = "${containerHome}/state"\ngateway_url = "ws://127.0.0.1:${API_PORT}/v1/nodes/connect"\nartifact_upload_url = "${API}/v1/artifacts"\npool = "mcp-real-${id}"\nagent_browser_bin = "${ENGINE}"\nchrome_bin = "/opt/proofrun/chromium-proxy"\nlisten = "127.0.0.1:19351"\npublic_url = "http://127.0.0.1:19351"\nallow_unverified_writes = true\nmax_session_ms = 14400000\nmemory_reserve_bytes = 67108864\nsession_reserve_bytes = 67108864\n`;
  docker(['tee', `${containerHome}/node.toml`], config);
  // Docker exec 前台客户端退出不保证容器子进程退出，因此保存本次 PID 并显式回收。
  docker([
    'sh',
    '-c',
    'python3 /workspace/tests/mcp-real/relay.py "$1" >"$2/relay.log" 2>&1 & echo $! >"$2/relay.pid"',
    'relay',
    String(API_PORT),
    containerHome,
  ]);
  processes.push('relay');
  await delay(500);
  const enrollment = await management('POST', '/v1/node-pairings', {
    type: 'node.enroll',
    pool: `mcp-real-${id}`,
    name: `codex-real-${id}`,
  });
  docker(['tee', `${containerHome}/pairing-token`], enrollment.pairingToken);
  docker(['chmod', '600', `${containerHome}/pairing-token`]);
  docker(['chown', '-R', 'proofrun:proofrun', containerHome]);
  const user = [
    'runuser',
    '-u',
    'proofrun',
    '--',
    'env',
    'XDG_RUNTIME_DIR=/run/user/1000',
    'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus',
  ];
  const pair = JSON.parse(
    (
      await promisify(execFile)('docker', [
        'exec',
        CONTAINER,
        ...user,
        NODE,
        '--config',
        `${containerHome}/node.toml`,
        'pair',
        '--pairing-token-file',
        `${containerHome}/pairing-token`,
      ])
    ).stdout,
  );
  docker(['rm', `${containerHome}/pairing-token`]);
  docker([
    ...user,
    'sh',
    '-c',
    '"$1" --config "$2/node.toml" serve >"$2/node.log" 2>&1 & echo $! >"$2/node.pid"',
    'node',
    NODE,
    containerHome,
  ]);
  processes.push('node');
  await until(
    () => management('GET', '/v1/nodes'),
    (v) =>
      v.nodes.some(
        (n) => n.id === pair.nodeId && n.online && n.admission?.accepting,
      ),
  );
  const caseInput = {
    requestId: `codex-${id}`,
    executor: { kind: 'external' },
    cases: [
      {
        caseId: `case-${id}`,
        platform: '真实 Codex Chromium 联调',
        entry: SITE,
        session: { mode: 'guest' },
        steps: [
          {
            stepId: 'prepare',
            type: 'setup',
            url: SITE,
            exec_order: 1,
            description:
              '打开联调记录页面，确认无需登录且初始记录为空。不要保存或删除记录。',
            policy: [
              '页面显示“暂无记录；记录数：0”，记录名称输入框和保存记录按钮可用',
            ],
            expected: [],
          },
          {
            stepId: 'verify',
            type: 'verification',
            url: SITE,
            exec_order: 2,
            description:
              '在记录名称输入框填写 MCP-REAL-001，点击保存记录一次，等待保存成功。',
            policy: [],
            expected: [
              '页面显示已保存 MCP-REAL-001；记录数：1，列表中有且仅有一条 MCP-REAL-001',
            ],
          },
        ],
        cleanup: [
          {
            stepId: 'cleanup',
            url: SITE,
            exec_order: 3,
            description:
              '点击删除记录一次，等待页面显示“暂无记录；记录数：0”，确认本次创建的记录已删除。',
            policy: [],
            expected: [],
          },
        ],
      },
    ],
  };
  await writeFile(
    join(directory, 'case.json'),
    JSON.stringify(caseInput, null, 2),
  );
  const mcp = Object.fromEntries(
    ['browser', 'verification'].map((channel) => [
      `proofrun_${channel}`,
      {
        url: `${API}/mcp/${channel}`,
        bearer_token_env_var: `PROOFRUN_${channel.toUpperCase()}_MCP_TOKEN`,
        startup_timeout_sec: 30,
        tool_timeout_sec: 60,
        required: true,
        default_tools_approval_mode: 'approve',
      },
    ]),
  );
  const configText =
    Object.entries(mcp)
      .map(
        ([name, entry]) =>
          `[mcp_servers.${name}]\n` +
          Object.entries(entry)
            .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
            .join('\n'),
      )
      .join('\n\n') + '\n';
  await writeFile(join(directory, 'codex.config.toml'), configText);
  await writeFile(
    join(directory, 'client.env'),
    `PROOFRUN_BROWSER_MCP_TOKEN=${tokens.browser}\nPROOFRUN_VERIFICATION_MCP_TOKEN=${tokens.verification}\n`,
    { mode: 0o600 },
  );
  await chmod(join(directory, 'client.env'), 0o600);
  const args = [
    'exec',
    '--ignore-user-config',
    '--skip-git-repo-check',
    '--json',
    '--color',
    'never',
    '-s',
    'read-only',
    '-c',
    'approval_policy="never"',
    '-c',
    'features.shell_tool=false',
    '-c',
    'features.multi_agent=false',
    '-c',
    'model_reasoning_effort="medium"',
  ];
  if (process.env.PROOFRUN_CODEX_MODEL)
    args.push('-m', process.env.PROOFRUN_CODEX_MODEL);
  for (const [name, entry] of Object.entries(mcp))
    for (const [key, value] of Object.entries(entry))
      args.push('-c', `mcp_servers.${name}.${key}=${JSON.stringify(value)}`);
  args.push('-o', join(directory, 'codex-final.txt'), '-');
  const prompt = await readFile(
    new URL('./prompt.md', import.meta.url),
    'utf8',
  );
  // Codex 不继承管理或 worker 凭据；两个公共令牌只在环境中提供。
  const env = {
    ...process.env,
    PROOFRUN_BROWSER_MCP_TOKEN: tokens.browser,
    PROOFRUN_VERIFICATION_MCP_TOKEN: tokens.verification,
  };
  delete env.CODEX_THREAD_ID;
  delete env.CODEX_SESSION_ID;
  console.log(
    JSON.stringify({
      event: 'ready',
      directory,
      api: API,
      nodeId: pair.nodeId,
      database,
    }),
  );
  const child = start(CLI, args, 'codex.jsonl', env);
  child.stdin.end(`${prompt}\n${JSON.stringify(caseInput, null, 2)}\n`);
  const timeout = setTimeout(() => child.kill('SIGTERM'), 30 * 60000);
  const [exitCode] = await once(child, 'exit');
  clearTimeout(timeout);
  const tasks = (
    await db.query('SELECT id,state,report,step_results FROM pr_tasks')
  ).rows;
  const executions = (
    await db.query(
      'SELECT e.id,e.task_id,e.state,s.closure_verified FROM pr_executions e JOIN pr_sessions s ON s.execution_id=e.id',
    )
  ).rows;
  const commands = (
    await db.query('SELECT kind,result FROM pr_commands ORDER BY created_at')
  ).rows;
  const operations = (
    await db.query('SELECT state,error_code FROM pr_external_operations')
  ).rows;
  const audit = {
    versions,
    transcript: transcriptFacts(
      await readFile(join(directory, 'codex.jsonl'), 'utf8'),
    ),
    exitCode,
    site: site.audit,
    tasks,
    executions,
    commands,
    operations,
    modelCalls: Number(
      (await db.query('SELECT count(*) FROM pr_model_calls')).rows[0].count,
    ),
  };
  await writeFile(
    join(directory, 'audit.json'),
    JSON.stringify(audit, null, 2),
  );
  verifyAudit(audit, caseInput);
  await writeFile(
    join(directory, 'report.json'),
    JSON.stringify(audit.tasks[0].report, null, 2),
  );
  console.log(
    JSON.stringify({ event: 'passed', directory, runId: tasks[0].id }),
  );
} finally {
  for (const child of children)
    if (child.exitCode === null) child.kill('SIGTERM');
  // 正常结束先让控制面停止执行并回收会话，再关闭本次节点；保留磁盘与数据库供报告复核。
  if (app) await app.close();
  if (site) await new Promise((resolve) => site.server.close(resolve));
  for (const name of processes.reverse()) {
    try {
      await writeFile(
        join(directory, `${name}.log`),
        docker(['cat', `${containerHome}/${name}.log`]),
        { mode: 0o600 },
      );
    } catch {}
    try {
      docker([
        'sh',
        '-c',
        'kill "$(cat "$1/$2.pid")"',
        'stop',
        containerHome,
        name,
      ]);
    } catch {}
  }
  if (db) await db.end();
  await admin.end();
}
