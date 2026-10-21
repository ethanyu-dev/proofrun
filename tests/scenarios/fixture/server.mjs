import { createServer, request } from 'node:http';
import { mkdir, chmod, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { CASES, SCENARIO_VERSION } from '../cases/catalog.mjs';
import { ID, read, save } from '../harness/storage.mjs';
import { page } from './pages.mjs';

/** 请求和事件均有界；管理入口使用私有 Unix socket，浏览器没有管理 HTTP 路由。 */
const BODY_BYTES = 16_384;
const MAX_EVENTS = 2_000;
const ASYNC_MS = 1_500;
const PANELS = {
  delivery: '标准配送需要三个工作日。',
  refund: '退款原路返回。',
};

/** 拒绝截断、超限和非 JSON 数据；不能用错误请求修改已保存的业务状态。 */
async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_BYTES) throw new Error('请求超限');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}

/** 每个样本独立锁；异步等待期间其他样本仍可运行。 */
export async function startFixture({
  directory,
  socketPath,
  host = '127.0.0.1',
  port = 0,
}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const queues = new Map();
  const serial = (id, operation) => {
    const work = (queues.get(id) ?? Promise.resolve()).then(operation);
    queues.set(
      id,
      work.catch(() => {}),
    );
    return work;
  };
  const file = (id) => {
    if (!ID.test(id)) throw new Error('非法样本身份');
    return join(directory, `${id}.json`);
  };
  const event = (state, type, data = {}) => {
    if (state.events.length >= MAX_EVENTS) throw new Error('事件额度耗尽');
    state.events.push({
      sequence: state.events.length + 1,
      at: new Date().toISOString(),
      type,
      ...data,
    });
  };
  const reply = (res, value, status = 200) => {
    res.writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify(value));
  };
  const admin = createServer(async (req, res) => {
    try {
      const id = req.url.slice(1);
      const path = file(id);
      const value = await serial(id, async () => {
        let state = await read(path);
        if (req.method === 'PUT') {
          const input = await body(req);
          const scenario = CASES.find((c) => c.id === input.scenarioId);
          if (!scenario || input.version !== SCENARIO_VERSION)
            throw new Error('场景版本不匹配');
          if (
            state &&
            (state.scenarioId !== scenario.id ||
              state.version !== input.version)
          )
            throw new Error('身份冲突');
          if (!state) {
            state = {
              id,
              scenarioId: scenario.id,
              kind: scenario.kind,
              version: SCENARIO_VERSION,
              code: randomBytes(8).toString('hex'),
              records: {},
              events: [],
              loggedIn: false,
            };
            await save(path, state);
          }
        } else if (req.method !== 'GET') throw new Error('非法管理操作');
        if (!state) throw new Error('样本不存在');
        return state;
      });
      reply(res, value);
    } catch {
      reply(res, { error: '夹具管理操作失败' }, 400);
    }
  });
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://fixture');
      const match = /^\/runs\/([A-Za-z0-9_-]{1,80})(\/action)?$/.exec(
        url.pathname,
      );
      if (!match) return reply(res, { error: '不存在' }, 404);
      const [, id, actionPath] = match;
      const response = await serial(id, async () => {
        const state = await read(file(id));
        if (!state) throw new Error('样本不存在');
        if (req.method === 'GET' && !actionPath) {
          const group = url.searchParams.get('group') ?? 'main';
          if (!['main', 'alpha', 'beta'].includes(group))
            throw new Error('分组无效');
          event(state, 'visit', { group, authenticated: state.loggedIn });
          await save(file(id), state);
          return { html: page(state.kind, group) };
        }
        if (req.method !== 'POST' || !actionPath) throw new Error('方法无效');
        const input = await body(req);
        const group = input.group ?? 'main';
        if (
          !['main', 'alpha', 'beta'].includes(group) ||
          typeof input.action !== 'string'
        )
          throw new Error('动作无效');
        let text = '';
        if (input.action === 'save') {
          if (typeof input.value !== 'string' || input.value.length > 200)
            throw new Error('字段无效');
          event(state, 'submit', {
            group,
            value: input.value,
            notify: input.notify === true,
          });
          if (
            state.kind === 'validation' &&
            !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.value)
          )
            text = '邮箱格式不正确';
          else if (state.kind === 'false-success') text = '保存成功';
          else {
            if (state.kind === 'async') await delay(ASYNC_MS);
            state.records[group] = {
              value: input.value,
              notify: input.notify === true,
            };
            event(state, 'commit', { group, ...state.records[group] });
            text = '保存成功，请查询记录核对';
          }
        } else if (input.action === 'validate') {
          const valid =
            typeof input.value === 'string' &&
            /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.value);
          event(state, 'validation', { valid });
          text = valid ? '邮箱格式正确' : '邮箱格式不正确';
        } else if (input.action === 'select') {
          if (
            ![
              'east',
              'west',
              ...Array.from({ length: 50 }, (_, i) => `city-${i + 1}`),
            ].includes(input.value)
          )
            throw new Error('选项无效');
          state.records[group] = { value: input.value };
          event(state, 'selection', { group, value: input.value });
          text = '已选择，请查询记录';
        } else if (input.action === 'panel' && PANELS[input.value]) {
          event(state, 'panel', { panel: input.value });
          text = PANELS[input.value];
        } else if (input.action === 'login') {
          state.loggedIn = input.value === state.code;
          event(state, 'login', { success: state.loggedIn });
          text = state.loggedIn ? '当前身份：测试用户' : '验证码不正确';
        } else if (input.action === 'delete') {
          delete state.records[group];
          event(state, 'delete', { group });
          text = '记录已删除，请查询确认';
        } else if (input.action === 'query') {
          const record = state.records[group];
          if (state.kind === 'human')
            text = state.loggedIn ? '当前身份：测试用户' : '当前身份：访客';
          else if (!record) text = '记录不存在';
          else if (state.kind === 'select')
            text = `已选择 Harbor（${record.value === 'west' ? '西' : '东'}区），编号 ${record.value}`;
          else if (state.kind === 'virtual')
            text = `已选择 ${record.value === 'city-40' ? 'Harbor' : '其他城市'}，编号 ${record.value}`;
          else if (state.kind === 'wizard')
            text = `项目 ${record.value}；通知${record.notify ? '已启用' : '未启用'}`;
          else if (state.kind === 'groups')
            text = `${group === 'alpha' ? '甲' : '乙'}组已保存 ${record.value}`;
          else
            text = `已保存${state.kind === 'validation' ? '邮箱' : '名称'} ${record.value}`;
          event(state, 'query', {
            group,
            record: record ?? null,
            authenticated: state.loggedIn,
            text,
          });
        } else throw new Error('不支持的动作');
        await save(file(id), state);
        return { text };
      });
      if (response.html) {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end(response.html);
      } else reply(res, response);
    } catch {
      reply(res, { error: '业务请求失败' }, 400);
    }
  });
  const listen = (s, ...args) =>
    new Promise((resolve, reject) => {
      s.once('error', reject);
      s.listen(...args, resolve);
    });
  try {
    await listen(admin, socketPath);
    await chmod(socketPath, 0o600);
    await listen(server, port, host);
  } catch (error) {
    admin.close();
    server.close();
    throw error;
  }
  return {
    port: server.address().port,
    async close() {
      await Promise.all([...queues.values()]);
      server.closeAllConnections();
      admin.closeAllConnections();
      await Promise.all(
        [server, admin].map((s) => new Promise((resolve) => s.close(resolve))),
      );
      await unlink(socketPath).catch((e) => {
        if (e.code !== 'ENOENT') throw e;
      });
    },
  };
}

/** 私有管理客户端使用 Unix socket，不把验证码放入公开页面或任务定义。 */
export function fixtureRequest(socketPath, id, input) {
  if (!ID.test(id)) throw new Error('非法样本身份');
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path: `/${id}`,
        method: input ? 'PUT' : 'GET',
        timeout: 10_000,
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > 4 * 1024 * 1024) res.destroy(new Error('夹具回复超限'));
          else chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => {
          try {
            if (res.statusCode !== 200) throw new Error('夹具管理请求失败');
            resolve(JSON.parse(Buffer.concat(chunks)));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('夹具管理超时')));
    req.on('error', reject);
    req.end(input ? JSON.stringify(input) : undefined);
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const directory = process.env.PROOFRUN_EVAL_FIXTURE_DIRECTORY;
  const socketPath = process.env.PROOFRUN_EVAL_FIXTURE_SOCKET;
  if (!directory || !socketPath)
    throw new Error('需要夹具目录与私有 socket 路径');
  const fixture = await startFixture({
    directory,
    socketPath,
    port: Number(process.env.PROOFRUN_EVAL_FIXTURE_PORT ?? 0),
    host: process.env.PROOFRUN_EVAL_FIXTURE_HOST ?? '127.0.0.1',
  });
  console.log(JSON.stringify({ port: fixture.port }));
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => {
      void fixture.close();
    });
}
