import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

// 只监听本机，避免把允许开发写动作的调试入口暴露到网络。
const HOST = '127.0.0.1';
// 每条页面命令最多运行 15 秒；HTTP 等待额外留给引擎启动与结果传输。
const COMMAND_TIMEOUT_MS = 15_000;
const RESPONSE_TIMEOUT_MS = 30_000;
// 测试会话最长保留一小时，避免遗留浏览器无限运行。
const SESSION_LIFETIME_MS = 60 * 60 * 1000;
// 请求体只承载少量固定浏览器命令，不接受任意大的输入。
const MAX_REQUEST_BYTES = 64 * 1024;
// 引擎适配器验证过的固定 CLI 版本。
const ENGINE_VERSION = '0.38.1';
// 静态页面目录与仓库根目录，用于定位资源和已构建的 Rust 二进制。
const ASSET_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(ASSET_DIR, '../../..');
// 调试桥接使用项目二进制；允许测试时覆盖路径。
const NODE_BINARY = resolve(
  process.env.PROOFRUN_TEST_BINARY ||
    join(REPO_ROOT, 'target/debug/proofrun-node'),
);
// 原生引擎必须由调用方明确指定，避免误用 npm 启动脚本。
const ENGINE_BINARY =
  process.env.PROOFRUN_AGENT_BROWSER_BIN &&
  resolve(process.env.PROOFRUN_AGENT_BROWSER_BIN);
// macOS 默认 Chrome 路径；其他系统需显式提供 Chromium 路径。
const DEFAULT_MAC_CHROME =
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CHROME_BINARY =
  process.env.PROOFRUN_CHROME_BIN ||
  (process.platform === 'darwin' ? DEFAULT_MAC_CHROME : '');
// 本地调试 HTTP 服务端口，避免与正式网关复用入口。
const PORT = Number(process.env.PROOFRUN_DEBUG_PORT || 8765);

// Linux host 使用系统启动时钟；macOS host 的时钟从进程启动计起。
function hostDeadline() {
  if (process.platform === 'linux') {
    const uptime = Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
    return Math.floor(uptime * 1000) + SESSION_LIFETIME_MS;
  }
  return SESSION_LIFETIME_MS;
}

function checkDependencies() {
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65_535) {
    throw new Error('PROOFRUN_DEBUG_PORT 必须是 1 到 65535 的端口');
  }
  if (!existsSync(NODE_BINARY)) {
    throw new Error(
      `找不到 Browser Node：${NODE_BINARY}，先运行 cargo build --locked -p proofrun-node`,
    );
  }
  if (!ENGINE_BINARY || !existsSync(ENGINE_BINARY)) {
    throw new Error(
      '设置 PROOFRUN_AGENT_BROWSER_BIN 为 0.38.1 原生二进制的绝对路径',
    );
  }
  if (!CHROME_BINARY || !existsSync(CHROME_BINARY)) {
    throw new Error(
      '设置 PROOFRUN_CHROME_BIN 为 Chrome/Chromium 可执行文件的绝对路径',
    );
  }
  const version = spawnSync(ENGINE_BINARY, ['--version'], {
    encoding: 'utf8',
    timeout: 5000,
  });
  if (
    version.error ||
    version.status !== 0 ||
    !version.stdout.trim().endsWith(` ${ENGINE_VERSION}`)
  ) {
    throw new Error(
      `agent-browser 需要 ${ENGINE_VERSION} 原生二进制，当前输出：${version.stdout || version.stderr || version.error}`,
    );
  }
}

// 单个页面调试会话对应同版本 proofrun-node 的一个内部 session-host 进程。
class DebugSession {
  constructor() {
    // 会话身份和临时 profile 与其他调试会话隔离。
    this.id = randomUUID();
    this.root = mkdtempSync(join(tmpdir(), 'proofrun-node-debug-'));
    this.child = spawn(
      NODE_BINARY,
      ['session-host', '--directory', this.root],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    // stdout 先于请求等待器到达时，响应留在队列里等待顺序消费。
    this.messages = [];
    this.waiter = null;
    // stderr 只保留尾部诊断，避免异常进程让内存无限增长。
    this.stderr = '';
    this.exited = false;
    // 最近一次可读取截图与观察身份；动作会使观察失效。
    this.lastScreenshot = null;
    this.observation = null;
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      try {
        this.deliver(JSON.parse(line));
      } catch (error) {
        this.fail(new Error(`session-host 返回无效 JSON：${error.message}`));
      }
    });
    this.child.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-16_384);
    });
    this.child.on('error', (error) => this.fail(error));
    this.child.on('exit', (code, signal) => {
      this.exited = true;
      this.fail(
        new Error(`session-host 已退出 (${code ?? signal})\n${this.stderr}`),
      );
    });
  }

  // JSONL 响应可能先于等待器到达，因此先缓存在队列里。
  deliver(message) {
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else {
      this.messages.push(message);
    }
  }

  fail(error) {
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  next() {
    if (this.messages.length) return Promise.resolve(this.messages.shift());
    if (this.exited)
      return Promise.reject(new Error(`session-host 已退出\n${this.stderr}`));
    return new Promise((resolveMessage, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error(`等待 session-host 响应超时\n${this.stderr}`));
      }, RESPONSE_TIMEOUT_MS);
      this.waiter = { resolve: resolveMessage, reject, timer };
    });
  }

  send(payload) {
    if (this.exited || !this.child.stdin.writable)
      throw new Error('浏览器会话已结束');
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    return { direction: '输入 → Browser Node session-host', payload };
  }

  async exchange(payload) {
    const input = this.send(payload);
    const output = await this.next();
    return [
      input,
      { direction: '输出 ← Browser Node session-host', payload: output },
    ];
  }

  async open() {
    const ready = await this.next();
    if (ready.type !== 'host.ready')
      throw new Error(`启动响应异常：${JSON.stringify(ready)}`);
    const init = {
      type: 'init',
      config: {
        binary: ENGINE_BINARY,
        chrome: resolve(CHROME_BINARY),
        session: this.id,
        directory: this.root,
        allow_unverified_writes: true,
      },
      deadline_ms: hostDeadline(),
    };
    const events = [
      { direction: '输出 ← Browser Node session-host', payload: ready },
      ...(await this.exchange(init)),
    ];
    const opened = events.at(-1).payload;
    if (opened.type !== 'host.opened' || !opened.result?.Ok) {
      throw new Error(
        `浏览器启动失败：${JSON.stringify(opened)}\n${this.stderr}`,
      );
    }
    return events;
  }

  async run(command) {
    const events = await this.exchange({
      type: 'run',
      command,
      timeout_ms: COMMAND_TIMEOUT_MS,
    });
    const result = events.at(-1).payload;
    if (result.type !== 'host.result')
      throw new Error(`命令响应异常：${JSON.stringify(result)}`);
    if (command.type === 'browser.observe' && result.result?.Ok) {
      this.observation = result.result.Ok;
      const screenshot = this.observation.localScreenshot;
      const artifactDir = join(this.root, 'artifacts') + sep;
      if (
        typeof screenshot === 'string' &&
        resolve(screenshot).startsWith(artifactDir)
      ) {
        this.lastScreenshot = screenshot;
      }
    } else if (command.type === 'browser.act') {
      this.observation = null;
    }
    return events;
  }

  async close() {
    if (!this.exited) {
      try {
        this.send({ type: 'close' });
        if (!this.exited) {
          await new Promise((resolveExit, reject) => {
            const timer = setTimeout(() => {
              this.child.off('exit', onExit);
              reject(new Error('关闭超时'));
            }, 5000);
            const onExit = () => {
              clearTimeout(timer);
              resolveExit();
            };
            this.child.once('exit', onExit);
          });
        }
      } catch {
        this.child.kill('SIGKILL');
      }
    }
    if (!this.exited) {
      await new Promise((resolveExit) => this.child.once('exit', resolveExit));
    }
    // host 异常退出时也请求引擎关闭本会话，避免遗留 macOS Chrome daemon。
    const socketDir =
      typeof process.getuid === 'function'
        ? join('/tmp', `proofrun-${process.getuid()}`, this.id)
        : null;
    if (existsSync(join(this.root, 'agent-browser.json'))) {
      const closed = spawnSync(
        ENGINE_BINARY,
        [
          '--config',
          join(this.root, 'agent-browser.json'),
          '--session',
          this.id,
          '--json',
          'close',
        ],
        {
          cwd: this.root,
          env: {
            PATH: process.env.PATH || '',
            HOME: join(this.root, 'home'),
            ...(socketDir ? { AGENT_BROWSER_SOCKET_DIR: socketDir } : {}),
          },
          timeout: 3000,
          encoding: 'utf8',
        },
      );
      if (closed.error) console.warn(`关闭引擎时出错：${closed.error.message}`);
    }
    rmSync(this.root, { recursive: true, force: true });
    // 引擎 socket 位于独立临时目录，只有本会话的路径可以被清理。
    if (socketDir) rmSync(socketDir, { recursive: true, force: true });
  }
}

// 页面仅能发送引擎公开的有限命令，不能把任意 host 管理消息交给服务。
function parseCommand(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('命令必须是对象');
  if (value.type === 'browser.observe') {
    return { type: value.type, screenshot: value.screenshot === true };
  }
  if (
    value.type === 'browser.act' &&
    ['navigate', 'click', 'fill', 'press', 'scroll'].includes(value.action)
  ) {
    const command = { type: value.type, action: value.action };
    if (typeof value.target === 'string') command.target = value.target;
    if (typeof value.value === 'string') command.value = value.value;
    if (typeof value.observationId === 'string')
      command.observationId = value.observationId;
    return command;
  }
  if (
    value.type === 'browser.wait' &&
    typeof value.selector === 'string' &&
    typeof value.text === 'string'
  ) {
    return { type: value.type, selector: value.selector, text: value.text };
  }
  throw new Error('仅支持观察、导航、点击、填写、按键、滚动和条件等待');
}

function reply(response, status, value) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}

async function readBody(request) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') {
    throw new Error('请求必须使用 application/json');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

checkDependencies();
let session = null;
let busy = false;
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/fixture', ['fixture.html', 'text/html; charset=utf-8']],
  ['/fixture.js', ['fixture.js', 'text/javascript; charset=utf-8']],
]);

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, `http://${HOST}:${PORT}`).pathname;
  try {
    if (request.method === 'GET' && assets.has(pathname)) {
      const [file, contentType] = assets.get(pathname);
      response.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy':
          "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'",
      });
      createReadStream(join(ASSET_DIR, file)).pipe(response);
      return;
    }
    if (request.method === 'GET' && pathname === '/api/status') {
      reply(response, 200, {
        active: Boolean(session && !session.exited),
        sessionId: session && !session.exited ? session.id : null,
        observation: session?.observation ?? null,
        hasScreenshot: Boolean(session?.lastScreenshot),
      });
      return;
    }
    if (request.method === 'GET' && pathname === '/api/screenshot') {
      if (!session?.lastScreenshot || !existsSync(session.lastScreenshot)) {
        reply(response, 404, { error: '暂无截图' });
        return;
      }
      response.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'no-store',
      });
      createReadStream(session.lastScreenshot).pipe(response);
      return;
    }
    if (
      request.method !== 'POST' ||
      !['/api/session/start', '/api/session/close', '/api/command'].includes(
        pathname,
      )
    ) {
      reply(response, 404, { error: '接口不存在' });
      return;
    }
    // 浏览器的跨站请求不能操纵本地允许写入的调试会话。
    const origin = request.headers.origin;
    if (origin && origin !== `http://${HOST}:${PORT}`) {
      reply(response, 403, { error: '仅允许本地调试页面发起请求' });
      return;
    }
    if (busy) {
      reply(response, 409, { error: '上一条浏览器命令仍在执行' });
      return;
    }
    busy = true;
    try {
      if (pathname === '/api/session/start') {
        if (session) await session.close();
        session = new DebugSession();
        let events;
        try {
          events = await session.open();
        } catch (error) {
          await session.close();
          session = null;
          throw error;
        }
        reply(response, 200, { sessionId: session.id, events });
      } else if (pathname === '/api/session/close') {
        if (!session) throw new Error('没有活动会话');
        const events = [
          {
            direction: '输入 → Browser Node session-host',
            payload: { type: 'close' },
          },
        ];
        await session.close();
        session = null;
        reply(response, 200, { events });
      } else {
        if (!session || session.exited) throw new Error('先启动浏览器会话');
        const command = parseCommand(await readBody(request));
        let events;
        try {
          events = await session.run(command);
        } catch (error) {
          await session.close();
          session = null;
          throw error;
        }
        reply(response, 200, {
          events,
          observation: session.observation,
          hasScreenshot: Boolean(session.lastScreenshot),
        });
      }
    } finally {
      busy = false;
    }
  } catch (error) {
    reply(response, 400, { error: error.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Browser Node 调试页：http://${HOST}:${PORT}`);
  console.log(
    `执行链路：proofrun-node session-host → agent-browser ${ENGINE_VERSION} → Chrome`,
  );
});

async function shutdown() {
  server.close();
  if (session) await session.close();
  process.exit(0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
