import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { ChatModel } from '../../apps/agent/dist/model/chat.js';
import { execute } from '../../packages/execution-driver/dist/execution/runner.js';
import { config, grant, FakeControl, finish, modelServer } from './fixture.mjs';

/** 仅本机 HTTP 夹具记录真实提交次数；没有账号、密码或外部服务。 */
const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>循环表单</title></head><body>
<form><label>Name <input name="name"></label><label>City <input name="city"></label><button>Save</button></form>
<p role="status">Ready</p><script>
document.querySelector('form').onsubmit = async event => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  await fetch('/save', {method:'POST', body: JSON.stringify(data)});
  document.querySelector('[role=status]').textContent = 'Saved ' + data.name + ' ' + data.city;
};
</script></body></html>`;
/** 单个会话管道的等待上限，失败后测试负责关闭自己的进程。 */
const HOST_TIMEOUT_MS = 30_000;

/** 使用真实 Rust session-host 和原生浏览器；控制面的租约、证据上传及模型回复由夹具模拟。 */
class BrowserControl extends FakeControl {
  constructor(host) {
    super();
    this.host = host;
  }
  async command(execution, id, operation) {
    const raw = await this.host.command(operation);
    const result = await super.command(execution, id, operation);
    if (operation.type === 'browser.observe') {
      const artifact = this.artifacts.at(-1);
      artifact.sha256 = createHash('sha256')
        .update(JSON.stringify(raw))
        .digest('hex');
      result.data = {
        ...raw,
        artifactRefs: [
          { artifactId: artifact.id, kind: 'DOM', sha256: artifact.sha256 },
        ],
      };
    } else result.data = raw;
    return result;
  }
}

/** 只启动独立临时会话，不使用用户已有 Chrome profile。 */
async function sessionHost() {
  const root = await mkdtemp(join(tmpdir(), 'proofrun-loop-'));
  const binary = resolve(
    process.env.PROOFRUN_TEST_BINARY ?? 'target/debug/proofrun-node',
  );
  const child = spawn(binary, ['session-host', '--directory', root], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  const queue = [];
  let waiter;
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    const value = JSON.parse(line);
    if (waiter) {
      const resolve = waiter;
      waiter = undefined;
      resolve(value);
    } else queue.push(value);
  });
  const receive = () =>
    queue.length
      ? Promise.resolve(queue.shift())
      : new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            waiter = undefined;
            reject(new Error(`会话回执超时：${stderr}`));
          }, HOST_TIMEOUT_MS);
          waiter = (value) => {
            clearTimeout(timer);
            resolve(value);
          };
        });
  const send = (value) => child.stdin.write(JSON.stringify(value) + '\n');
  const host = {
    async command(operation) {
      send({ type: 'run', command: operation, timeout_ms: 15000 });
      const result = await receive();
      assert('Ok' in result.result, JSON.stringify(result));
      return result.result.Ok;
    },
    async close() {
      if (child.exitCode === null) {
        const exited = once(child, 'exit');
        const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
        send({ type: 'close' });
        await exited;
        clearTimeout(timer);
      }
      lines.close();
      await rm(root, { recursive: true, force: true });
    },
  };
  try {
    assert.equal((await receive()).type, 'host.ready');
    const boot =
      process.platform === 'linux'
        ? Number((await readFile('/proc/uptime', 'utf8')).split(' ')[0]) * 1000
        : 0;
    send({
      type: 'init',
      config: {
        binary: resolve(process.env.PROOFRUN_AGENT_BROWSER_BIN),
        chrome: resolve(process.env.PROOFRUN_CHROME_BIN),
        session: randomUUID().replaceAll('-', ''),
        directory: root,
        allow_unverified_writes: true,
      },
      deadline_ms: Math.floor(boot + 120000),
      startup_deadline_ms: Math.floor(boot + 30000),
    });
    const initialized = await receive();
    assert('Ok' in initialized.result, JSON.stringify(initialized));
    return host;
  } catch (error) {
    await host.close();
    throw error;
  }
}

// 范围：真实 Node/Chrome 的填写、提交、重新观察和独立 HTTP 写入计数；不覆盖真实模型质量或控制面上传。
test(
  '单一 LLM 循环在真实浏览器连续填写且只提交一次',
  {
    timeout: 90_000,
    skip:
      !process.env.PROOFRUN_AGENT_BROWSER_BIN ||
      !process.env.PROOFRUN_CHROME_BIN,
  },
  async () => {
    const writes = [];
    const site = createServer(async (request, response) => {
      if (request.url === '/save') {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        writes.push(JSON.parse(Buffer.concat(chunks).toString()));
        response.setHeader('content-type', 'application/json');
        response.end('{}');
      } else {
        response.setHeader('content-type', 'text/html; charset=utf-8');
        response.end(HTML);
      }
    });
    await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
    let host, server;
    try {
      host = await sessionHost();
      const execution = grant();
      execution.task.target.url = `http://127.0.0.1:${site.address().port}`;
      execution.task.objective =
        '填写 Name 为 Alice，City 为 Hangzhou，然后提交并核对成功提示';
      execution.task.acceptanceCriteria[0].expectedResult =
        'Saved Alice Hangzhou';
      execution.task.executionMode = 'llm';
      execution.task.budget = { timeoutMs: 120000, maxActions: 8 };
      execution.taskDeadlineAt = new Date(Date.now() + 120000).toISOString();
      server = await modelServer((context, count) => {
        if (count === 1)
          return {
            type: 'browser.act',
            action: 'fill',
            target: context.page.targets.find((t) => t.name === 'Name').target,
            value: 'Alice',
          };
        if (count === 2)
          return {
            type: 'browser.act',
            action: 'fill',
            target: context.page.targets.find((t) => t.name === 'City').target,
            value: 'Hangzhou',
          };
        if (count === 3)
          return {
            type: 'browser.act',
            action: 'click',
            target: context.page.targets.find((t) => t.name === 'Save').target,
          };
        assert(count <= 6, '异步提交最多等待有限次观察');
        if (!context.page.text.includes('Saved Alice Hangzhou'))
          return { type: 'browser.observe' };
        return finish(context);
      });
      const settings = {
        ...config,
        modelUrl: server.url,
        maxTurns: 12,
        maxContextChars: 64000,
        commandMs: 15000,
      };
      const control = new BrowserControl(host);
      const report = await execute(
        settings,
        control,
        new ChatModel(settings),
        execution,
      );
      assert.deepEqual(server.errors, []);
      assert.equal(report.verdict, 'PASSED', JSON.stringify(report));
      assert.deepEqual(writes, [{ name: 'Alice', city: 'Hangzhou' }]);
      assert.equal(
        control.calls.filter((c) => c.operation.action === 'click').length,
        1,
      );
      assert.equal(
        control.modelCalls.filter(
          (c) =>
            c.body.phase === 'start' && c.body.record.purpose === 'FIELD_VALUE',
        ).length,
        0,
      );
    } finally {
      await server?.close();
      await host?.close();
      site.closeAllConnections();
      await new Promise((resolve) => site.close(resolve));
    }
  },
);
