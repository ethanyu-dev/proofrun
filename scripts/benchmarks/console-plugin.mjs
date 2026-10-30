import { spawn } from 'node:child_process';
import { readdir, readFile, stat, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/** 仅开发态、回环地址、同源请求开放固定命令；生产构建只支持导入归档。 */
const ENDPOINT = '/__benchmark';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUTPUT = resolve(ROOT, '.proofrun/benchmarks');
const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** V2 多步骤网络原文单独限制体积，不改变基础套件或执行门限。 */
const V2_MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_RUNS = 20;
const RUN_TIMEOUT_MS = 120000;
/** 真实套件十例各三分钟，另留构建与关闭预算。 */
const REAL_TIMEOUT_MS = 35 * 60 * 1000;
/** 两项历史 V2 完整步骤含既有收尾预算，总宿主上限固定为三小时，不改变任务内预算。 */
const V2_TIMEOUT_MS = 180 * 60 * 1000;
const V2_SUITE = 'agent-loop-v2-live-v1';

/** 本地结果不会打包进 dist；开发服务关闭时同时终止其启动的基准进程组。 */
export function benchmarkConsole({ spawnProcess = spawn } = {}) {
  let child = null;
  let activeFamily = null;
  let lastError = null;
  let log = '';
  let timer;
  const stop = () => {
    if (child) {
      try {
        process.platform === 'win32'
          ? child.kill()
          : process.kill(-child.pid, 'SIGTERM');
      } catch {
        /* 进程可能已经退出。 */
      }
    }
    clearTimeout(timer);
  };
  return {
    name: 'proofrun-local-benchmark',
    apply: 'serve',
    configureServer(server) {
      server.httpServer?.once('close', stop);
      server.middlewares.use(async (request, response, next) => {
        if (request.url?.split('?')[0] !== ENDPOINT) return next();
        const send = (status, value) => {
          response.statusCode = status;
          response.setHeader('Content-Type', 'application/json');
          response.setHeader('Cache-Control', 'no-store');
          response.end(JSON.stringify(value));
        };
        const host = request.headers.host;
        const remote = request.socket.remoteAddress;
        // 不接受远端连接、DNS rebinding、跨站读取或跨源 POST，不能从网页传入命令和文件路径。
        if (
          !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote) ||
          !host ||
          !/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)
        )
          return send(403, { error: '本地 Benchmark 只允许回环访问' });
        if (
          request.headers.origin &&
          ![`http://${host}`, `https://${host}`].includes(
            request.headers.origin,
          )
        )
          return send(403, { error: '只允许当前控制台同源访问' });
        if (
          request.headers['sec-fetch-site'] &&
          !['same-origin', 'none'].includes(request.headers['sec-fetch-site'])
        )
          return send(403, { error: '禁止跨站访问本地结果' });
        try {
          if (request.method === 'POST') {
            if (
              !request.headers.origin ||
              request.headers['content-type'] !== 'application/json'
            )
              return send(403, { error: '运行请求必须来自当前控制台' });
            if (child)
              return send(409, { error: '已有一轮 Benchmark 正在运行' });
            let body = '';
            for await (const chunk of request) {
              body += chunk.toString();
              if (body.length > 1024)
                return send(413, { error: '运行参数过大' });
            }
            let input;
            try {
              input = JSON.parse(body || '{}');
            } catch {
              return send(400, { error: '运行参数必须是 JSON' });
            }
            if (
              !input ||
              Array.isArray(input) ||
              typeof input !== 'object' ||
              Object.keys(input).some(
                (key) => !['mode', 'version'].includes(key),
              ) ||
              !['real', 'scripted', 'v2'].includes(input.mode ?? 'scripted')
            )
              return send(400, {
                error: '只接受 real / scripted / v2 固定运行模式',
              });
            if (
              input.version !== undefined &&
              (typeof input.version !== 'string' ||
                !/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/.test(input.version))
            )
              return send(400, { error: '发布版本格式无效' });
            const mode = input.mode ?? 'scripted';
            const args = [
              mode === 'v2'
                ? 'benchmark:v2'
                : mode === 'real'
                  ? input.version
                    ? 'benchmark:release'
                    : 'benchmark:real'
                  : 'benchmark:agent',
            ];
            if (input.version) args.push('--version', input.version);
            // 显式固定文件只由本机开发者维护，页面不能传入路径或环境变量。
            if (
              ['real', 'v2'].includes(mode) &&
              (await access(resolve(ROOT, '.proofrun/local.env')).then(
                () => true,
                () => false,
              ))
            )
              args.push('--env-file', '.proofrun/local.env');
            if (child)
              return send(409, { error: '已有一轮 Benchmark 正在运行' });
            log = '';
            lastError = null;
            activeFamily = mode === 'v2' ? 'v2' : 'browser';
            child = spawnProcess('pnpm', args, {
              cwd: ROOT,
              stdio: ['ignore', 'pipe', 'pipe'],
              detached: process.platform !== 'win32',
            });
            const append = (chunk) => {
              log = (log + chunk.toString()).slice(-12000);
            };
            child.stdout.on('data', append);
            child.stderr.on('data', append);
            child.on('error', (error) => {
              lastError = error.message;
            });
            child.on('close', (code) => {
              if (code !== 0 && !lastError)
                lastError = `Benchmark 未通过（退出码 ${code}），请查看结果及日志`;
              child = null;
              clearTimeout(timer);
            });
            timer = setTimeout(
              () => {
                lastError = '运行超过固定时限，已终止本次本地任务';
                stop();
              },
              mode === 'v2'
                ? V2_TIMEOUT_MS
                : mode === 'real'
                  ? REAL_TIMEOUT_MS
                  : RUN_TIMEOUT_MS,
            );
            return send(202, { running: true });
          }
          if (request.method !== 'GET')
            return send(405, { error: '不支持的请求方法' });
          const files = await readdir(OUTPUT).catch((error) => {
            if (error.code === 'ENOENT') return [];
            throw error;
          });
          const runs = [];
          const family =
            new URL(request.url, `http://${host}`).searchParams.get('family') ??
            'browser';
          if (!['browser', 'v2'].includes(family))
            return send(400, { error: '未知测试集' });
          const limit = family === 'v2' ? V2_MAX_FILE_BYTES : MAX_FILE_BYTES;
          let bytes = 0;
          const errors = [];
          for (const name of files
            .filter((name) => name.endsWith('.json'))
            .sort()
            .reverse()) {
            try {
              const path = resolve(OUTPUT, name);
              const size = (await stat(path)).size;
              if (size > V2_MAX_FILE_BYTES) throw new Error('文件超过 64 MiB');
              const run = JSON.parse(await readFile(path, 'utf8'));
              if ((run.suite === V2_SUITE) !== (family === 'v2')) continue;
              if (size > limit) throw new Error('文件超过当前测试集体积上限');
              if (run.mode === 'real' && !run.completedAt) continue;
              if (bytes + size > limit || runs.length >= MAX_RUNS) break;
              bytes += size;
              if (run.mode !== 'real' || run.completedAt) runs.push(run);
            } catch (error) {
              errors.push(`${name}: ${error.message}`);
            }
          }
          return send(200, {
            running: child !== null,
            activeFamily: child ? activeFamily : null,
            error: lastError,
            log,
            runs,
            errors,
          });
        } catch (error) {
          return send(500, { error: error.message });
        }
      });
    },
  };
}
