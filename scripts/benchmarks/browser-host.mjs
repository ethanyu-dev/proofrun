import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** 本地会话独立固定期限；不会操作用户已打开的 Chrome 或复用其 profile。 */
const START_MS = 30000;
const CLOSE_MS = 15000;

/** 通过生产 session-host 协议执行真实 Node/Chrome；失败不伪造成功命令回执。 */
export async function browserHost(runtime, timeoutMs, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'proofrun-real-benchmark-'));
  const child = spawn(
    runtime.node,
    ['session-host', '--directory', directory],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const lines = createInterface({ input: child.stdout });
  const queue = [];
  let waiter = null,
    failure = null,
    closed = false;
  child.stderr.resume();
  const exited = new Promise((resolve) =>
    child.once('close', (code) => {
      closed = true;
      fail(new Error(`浏览器宿主结束：${code}`));
      resolve(code);
    }),
  );
  function fail(error) {
    failure = error;
    waiter?.reject(error);
    waiter = null;
  }
  child.on('error', () => fail(new Error('无法启动浏览器宿主')));
  child.stdin.on('error', () => fail(new Error('浏览器宿主管道已关闭')));
  lines.on('line', (line) => {
    try {
      const value = JSON.parse(line);
      if (waiter) {
        const pending = waiter;
        waiter = null;
        pending.resolve(value);
      } else queue.push(value);
    } catch {
      fail(new Error('浏览器宿主返回非 JSON 回执'));
    }
  });
  function receive(ms) {
    if (queue.length) return Promise.resolve(queue.shift());
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiter = null;
        reject(new Error('浏览器宿主回执超时'));
      }, ms);
      waiter = {
        resolve(value) {
          clearTimeout(timer);
          resolve(value);
        },
        reject(error) {
          clearTimeout(timer);
          reject(error);
        },
      };
    });
  }
  function send(value) {
    if (failure) throw failure;
    child.stdin.write(JSON.stringify(value) + '\n');
  }
  const host = {
    directory,
    /** 来自实际宿主启动回执，不能依据模型或任务声明推断访客身份。 */
    environmentProof: null,
    /** 命令串行，返回原始 Ok/Err；调用者负责将生产错误码映射为执行端口协议。 */
    async command(operation, ms = 20000) {
      send({ type: 'run', command: operation, timeout_ms: ms });
      const reply = await receive(ms + 5000);
      if (reply.type !== 'host.result' || !reply.result)
        throw new Error('浏览器宿主命令回执不匹配');
      return reply.result;
    },
    /** host 正常退出才算关闭确认；强杀只负责回收并使关闭检查失败。 */
    async close() {
      let forced = false;
      if (!closed && !child.stdin.destroyed)
        child.stdin.end(JSON.stringify({ type: 'close' }) + '\n');
      const timer = setTimeout(() => {
        forced = true;
        child.kill('SIGKILL');
      }, CLOSE_MS);
      const code = await exited;
      clearTimeout(timer);
      lines.close();
      await rm(directory, { recursive: true, force: true });
      if (forced || code !== 0) throw new Error('浏览器会话未正常关闭');
    },
  };
  try {
    if ((await receive(START_MS)).type !== 'host.ready')
      throw new Error('浏览器宿主未就绪');
    const boot =
      process.platform === 'linux'
        ? Number((await readFile('/proc/uptime', 'utf8')).split(' ')[0]) * 1000
        : 0;
    send({
      type: 'init',
      config: {
        binary: runtime.engine,
        chrome: runtime.chrome,
        session: randomUUID().replaceAll('-', ''),
        directory,
        allow_unverified_writes: true,
        network_evidence: options.networkEvidence === true,
      },
      deadline_ms: Math.floor(boot + timeoutMs + START_MS),
      startup_deadline_ms: Math.floor(boot + START_MS),
    });
    const ready = await receive(START_MS + 5000);
    if (!ready.result || !Object.hasOwn(ready.result, 'Ok'))
      throw new Error(
        `浏览器初始化失败：${ready.result?.Err?.code ?? 'UNKNOWN'}`,
      );
    host.environmentProof = ready.result.Ok.environmentProof ?? null;
    return host;
  } catch (error) {
    await host.close().catch(() => {});
    throw error;
  }
}
