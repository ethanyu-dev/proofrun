import { spawn, execFileSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  openSync,
  closeSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { X509Certificate } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

/** 此入口复用本机已有 preview 容器和数据，不创建另一套数据库或节点身份。 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME = join(ROOT, '.proofrun/runtime');
const CONTAINER = 'proofrun-preview-runtime-1';
const API_PORT = 4101;
const CONSOLE_PORT = 5173;
const RELAY_PORT = 4443;
const ORIGIN = `http://127.0.0.1:${API_PORT}`;
const STATE_FILE = join(RUNTIME, 'mac-services.json');
const CERT = join(RUNTIME, 'local-relay.crt');
const KEY = join(RUNTIME, 'local-relay.key');
const ENV_FILE = join(ROOT, '.proofrun/local.env');
const PROFILE = join(ROOT, '.proofrun/case-profile.json');
const NO_AGENT = process.argv.includes('--no-agent');

/** Node 24 需要显式启用环境代理；仅向 Agent 传递，NO_PROXY 保留控制面直连。 */
const AGENT_PROXY_KEYS = [
  'NODE_USE_ENV_PROXY',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
];

/** 服务环境只分发职责所需配置；Console 不继承管理员或模型密钥。 */
const API_KEYS = [
  'PROOFRUN_DATABASE_URL',
  'PROOFRUN_ADMIN_TOKEN',
  'PROOFRUN_WORKER_TOKEN',
  'PROOFRUN_PUBLIC_URL',
  'PROOFRUN_CONSOLE_URL',
  'PROOFRUN_ARTIFACT_DIRECTORY',
  'PROOFRUN_CASE_PROFILE_FILE',
  'PROOFRUN_API_HOST',
  'PROOFRUN_API_PORT',
];
const settings = parseEnv(readFileSync(ENV_FILE, 'utf8'));
const baseEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.startsWith('PROOFRUN_') && !key.startsWith('TYPESAFE_'),
  ),
);
const state = existsSync(STATE_FILE)
  ? JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  : { processes: {}, artifactsCopied: false };

/** 同步工具输出保留构建诊断；所有密钥通过文件或环境传递，不进入命令参数。 */
function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: ROOT,
    env: baseEnvironment,
    stdio: 'inherit',
    ...options,
  });
}

/** 统一使用容器普通用户管理器，避免启动第二份 root 节点。 */
function systemctl(...args) {
  run('docker', [
    'exec',
    CONTAINER,
    'runuser',
    '-u',
    'proofrun',
    '--',
    'env',
    'XDG_RUNTIME_DIR=/run/user/1000',
    'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus',
    'systemctl',
    '--user',
    ...args,
  ]);
}

/** PID 可能过期或被复用；只有命令包含本项目入口时才允许停止。 */
function commandOf(pid) {
  try {
    return run('ps', ['-p', String(pid), '-o', 'command='], {
      stdio: 'pipe',
      encoding: 'utf8',
    }).trim();
  } catch {
    return '';
  }
}

async function stopOwned(pid, entry) {
  if (!commandOf(pid).includes(entry)) return;
  process.kill(pid, 'SIGTERM');
  for (let i = 0; i < 50 && commandOf(pid).includes(entry); i++)
    await delay(200);
  if (commandOf(pid).includes(entry)) process.kill(pid, 'SIGKILL');
}

/** 按本项目工作目录确认旧版 Vite，其他程序占用端口时明确停止启动。 */
async function releaseConsole() {
  let pids;
  try {
    pids = run('lsof', ['-t', '-iTCP:5173', '-sTCP:LISTEN'], {
      stdio: 'pipe',
      encoding: 'utf8',
    })
      .trim()
      .split(/\s+/)
      .filter(Boolean);
  } catch {
    return;
  }
  for (const pid of pids) {
    const command = commandOf(pid);
    if (
      !command.includes(join(ROOT, 'apps/console')) ||
      !command.includes('vite')
    )
      throw new Error('5173 被其他程序占用，未停止该程序');
    await stopOwned(Number(pid), join(ROOT, 'apps/console'));
  }
}

/** 未被启动器记录的端口占用不能被当作本项目服务复用或强制结束。 */
function requireFreePort(port) {
  let listeners;
  try {
    listeners = run('lsof', ['-t', `-iTCP:${port}`, '-sTCP:LISTEN'], {
      stdio: 'pipe',
      encoding: 'utf8',
    }).trim();
  } catch {
    return;
  }
  if (listeners) throw new Error(`${port} 被其他进程占用，未启动重复服务`);
}

/** 就绪探测只证明服务可达，不代表模型额度或业务验收通过。 */
async function waitHttp(url) {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch {}
    await delay(500);
  }
  throw new Error(`服务未就绪：${url}，请检查 ${RUNTIME} 下的日志`);
}

/** 后台进程有独立日志与 PID；重复运行只重启这些已确认归属的进程。 */
function start(name, entry, args, environment, cwd = ROOT) {
  const log = openSync(join(RUNTIME, `local-${name}.log`), 'a', 0o600);
  const child = spawn(process.execPath, [entry, ...args], {
    cwd,
    env: { ...baseEnvironment, ...environment },
    detached: true,
    stdio: ['ignore', log, log],
  });
  closeSync(log);
  child.unref();
  state.processes[name] = { pid: child.pid, entry };
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n', {
    mode: 0o600,
  });
}

/** 单机迁移时保留既有证据；后续运行不把旧容器数据覆盖回本机。 */
async function main() {
  if (process.platform !== 'darwin')
    throw new Error('该入口用于当前 Mac + Docker 开发环境');
  mkdirSync(RUNTIME, { recursive: true, mode: 0o700 });
  for (const key of [
    'PROOFRUN_DATABASE_URL',
    'PROOFRUN_ADMIN_TOKEN',
    'PROOFRUN_WORKER_TOKEN',
    'PROOFRUN_MODEL_BASE_URL',
    'PROOFRUN_MODEL_API_KEY',
    'PROOFRUN_MODEL',
  ])
    if (!settings[key]) throw new Error(`${ENV_FILE} 缺少 ${key}`);
  if (!existsSync(PROFILE)) {
    const profile = JSON.parse(
      readFileSync(join(ROOT, 'deploy/case-profile.example.json'), 'utf8'),
    );
    profile.environment.id = 'local-preview';
    writeFileSync(PROFILE, JSON.stringify(profile, null, 2) + '\n', {
      mode: 0o600,
    });
  }
  run('pnpm', ['contracts:generate']);
  run('pnpm', ['--filter', '@proofrun/contracts', 'build']);
  run('pnpm', ['--filter', './apps/*', '-r', 'build']);
  run(process.execPath, [
    '--input-type=module',
    '-e',
    "import { loadCaseProfile } from './apps/api/dist/modules/cases/profile.js'; loadCaseProfile(process.argv[1]);",
    PROFILE,
  ]);
  run('docker', [
    'compose',
    '-f',
    join(RUNTIME, 'compose.yml'),
    'start',
    '--wait',
    '--wait-timeout',
    '60',
    'postgres',
    'runtime',
  ]);
  run('docker', ['exec', CONTAINER, 'systemctl', 'start', 'user@1000.service']);
  run('docker', [
    'exec',
    '-w',
    '/workspace',
    CONTAINER,
    'cargo',
    'build',
    '--locked',
    '-p',
    'proofrun-node',
  ]);
  // 首次从 Docker API 切换时与后续 Mac API 重启都要保留正在执行的任务。
  for (const origin of [ORIGIN, 'http://127.0.0.1:4100']) {
    let response;
    try {
      response = await fetch(`${origin}/v1/tasks`, {
        headers: { Authorization: `Bearer ${settings.PROOFRUN_ADMIN_TOKEN}` },
        signal: AbortSignal.timeout(2000),
      });
    } catch {
      continue;
    }
    if (!response.ok) throw new Error('无法确认已有任务状态，未重启服务');
    const result = await response.json();
    if ((result.tasks ?? result).some((task) => task.state === 'RUNNING'))
      throw new Error('存在运行中的任务，请结束任务后再重启');
  }
  systemctl(
    'stop',
    'proofrun-agent.service',
    'proofrun-node.service',
    'proofrun-api.service',
  );
  systemctl('disable', 'proofrun-api.service', 'proofrun-agent.service');
  for (const service of Object.values(state.processes))
    await stopOwned(service.pid, service.entry);
  await releaseConsole();
  requireFreePort(API_PORT);
  requireFreePort(RELAY_PORT);
  const artifacts = join(ROOT, '.proofrun/api-artifacts');
  mkdirSync(artifacts, { recursive: true, mode: 0o700 });
  if (!state.artifactsCopied) {
    run('docker', [
      'cp',
      `${CONTAINER}:/var/lib/proofrun/api-artifacts/.`,
      artifacts,
    ]);
    state.artifactsCopied = true;
  }
  // 专用开发证书只供 Docker 转发使用，不修改系统信任或关闭 TLS 校验。
  if (
    !existsSync(CERT) ||
    !existsSync(KEY) ||
    Date.parse(new X509Certificate(readFileSync(CERT)).validTo) <
      Date.now() + 7 * 86400000
  ) {
    const config = join(RUNTIME, 'local-relay-openssl.cnf');
    writeFileSync(
      config,
      '[req]\ndistinguished_name=dn\nx509_extensions=extensions\nprompt=no\n[dn]\nCN=proofrun-local-relay\n[extensions]\nsubjectAltName=DNS:proofrun-local-relay\nbasicConstraints=critical,CA:TRUE\n',
    );
    run(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '365',
        '-config',
        config,
        '-keyout',
        KEY,
        '-out',
        CERT,
      ],
      { stdio: 'pipe' },
    );
  }
  Object.assign(settings, {
    PROOFRUN_API_HOST: '127.0.0.1',
    PROOFRUN_API_PORT: String(API_PORT),
    PROOFRUN_PUBLIC_URL: ORIGIN,
    PROOFRUN_CONTROL_URL: ORIGIN,
    PROOFRUN_CONSOLE_URL: `http://127.0.0.1:${CONSOLE_PORT}`,
    PROOFRUN_CASE_PROFILE_FILE: PROFILE,
    PROOFRUN_ARTIFACT_DIRECTORY: artifacts,
  });
  start(
    'api',
    join(ROOT, 'apps/api/dist/main.js'),
    [],
    Object.fromEntries(API_KEYS.map((key) => [key, settings[key]])),
  );
  await waitHttp(`${ORIGIN}/health/ready`);
  start(
    'relay',
    join(ROOT, 'scripts/dev-api-relay.mjs'),
    [CERT, KEY, String(RELAY_PORT), String(API_PORT)],
    {},
  );
  const unit =
    '[Unit]\nDescription=ProofRun local Mac API TLS relay\n[Service]\nExecStart=/usr/bin/python3 /workspace/scripts/dev-node-relay.py\nRestart=on-failure\nRestartSec=2\nUMask=0077\n';
  run(
    'docker',
    [
      'exec',
      '-i',
      CONTAINER,
      'runuser',
      '-u',
      'proofrun',
      '--',
      'tee',
      '/home/proofrun/.config/systemd/user/proofrun-local-relay.service',
    ],
    { input: unit, stdio: ['pipe', 'ignore', 'inherit'] },
  );
  systemctl('daemon-reload');
  systemctl('restart', 'proofrun-local-relay.service');
  run('docker', [
    'exec',
    CONTAINER,
    'curl',
    '--fail',
    '--silent',
    '--retry',
    '10',
    '--retry-connrefused',
    '--retry-delay',
    '1',
    '--max-time',
    '3',
    'http://127.0.0.1:4100/health/ready',
  ]);
  systemctl('start', 'proofrun-node.service');
  // 测试页面使用临时单元，容器重启后重新创建；不会重置仍在运行的页面。
  try {
    run(
      'docker',
      [
        'exec',
        CONTAINER,
        'runuser',
        '-u',
        'proofrun',
        '--',
        'env',
        'XDG_RUNTIME_DIR=/run/user/1000',
        'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus',
        'systemctl',
        '--user',
        'is-active',
        '--quiet',
        'proofrun-smoke-page.service',
      ],
      { stdio: 'pipe' },
    );
  } catch {
    run('docker', [
      'exec',
      CONTAINER,
      'runuser',
      '-u',
      'proofrun',
      '--',
      'env',
      'XDG_RUNTIME_DIR=/run/user/1000',
      'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus',
      'systemd-run',
      '--user',
      '--collect',
      '--unit=proofrun-smoke-page',
      '--property=UMask=0077',
      '/usr/bin/python3',
      '/var/lib/proofrun/smoke-page.py',
    ]);
  }
  if (!NO_AGENT)
    start(
      'agent',
      join(ROOT, 'apps/agent/dist/main.js'),
      ['serve'],
      Object.fromEntries(
        Object.entries(settings).filter(
          ([key]) =>
            /^PROOFRUN_(MODEL|AGENT|CONTROL_URL|WORKER_TOKEN|WORKER_ID)/.test(
              key,
            ) ||
            key.startsWith('TYPESAFE_') ||
            AGENT_PROXY_KEYS.includes(key),
        ),
      ),
    );
  start(
    'console',
    join(ROOT, 'apps/console/node_modules/vite/bin/vite.js'),
    ['--host', '127.0.0.1', '--port', String(CONSOLE_PORT), '--strictPort'],
    { PROOFRUN_API_PROXY: ORIGIN },
    join(ROOT, 'apps/console'),
  );
  await waitHttp(`http://127.0.0.1:${CONSOLE_PORT}`);
  console.log(
    `本机服务已启动：Console http://127.0.0.1:${CONSOLE_PORT}；API ${ORIGIN}${NO_AGENT ? '；Agent 暂未启动' : ''}`,
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
