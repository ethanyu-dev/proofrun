import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import {
  HitlConnection,
  type ConnectionState,
} from '../../apps/console/src/pages/hitl-connection';

/** 可控 HTTP/WS 和计时器夹具；验证连接恢复边界，不代替真实 TLS 或节点授权。 */
function harness(context: TestContext) {
  const sockets: Socket[] = [];
  let requests = 0;
  let response: { status: number; body: unknown } | undefined;
  class Socket {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    sent: any[] = [];
    constructor(readonly url: string) {
      sockets.push(this);
    }
    open() {
      this.readyState = 1;
      this.onopen?.();
    }
    send(raw: string) {
      this.sent.push(JSON.parse(raw));
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
    receive(message: unknown) {
      this.onmessage?.({ data: JSON.stringify(message) });
    }
  }
  const previous = { fetch: globalThis.fetch, WebSocket: globalThis.WebSocket };
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  globalThis.fetch = (async () => {
    requests++;
    const result = response ?? {
      status: 200,
      body: {
        direct: {
          nodeId: 'node',
          id: 'link',
          token: `credential-${requests}`,
          controlUrl: 'wss://node.test/hitl/control',
          frameUrl: 'wss://node.test/hitl/frames',
        },
      },
    };
    return {
      ok: result.status === 200,
      status: result.status,
      json: async () => result.body,
    };
  }) as typeof fetch;
  const states: ConnectionState[] = [],
    messages: any[] = [];
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const connection = new HitlConnection({
    id: 'link',
    token: 'entry-token',
    message: (message) => messages.push(message),
    closed: () => {},
    error: () => {},
    status: (state) => states.push(state),
  });
  context.after(() => {
    connection.close();
    context.mock.timers.reset();
    Object.assign(globalThis, previous);
  });
  const flush = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  return {
    sockets,
    connection,
    states,
    messages,
    flush,
    requests: () => requests,
    reply: (status: number, body: unknown) => {
      response = { status, body };
    },
    tick: async (ms: number) => {
      context.mock.timers.tick(ms);
      await flush();
    },
    connect: (index: number) => {
      sockets[index]!.open();
      sockets[index]!.receive({ type: 'state', mode: 'HUMAN' });
      sockets[index + 1]!.open();
      sockets[index + 1]!.receive({
        type: 'frame',
        data: 'fixture',
        width: 1280,
        height: 720,
      });
    },
  };
}

// 范围：掉线换新凭据、旧回调失效、输入不重放；不执行真实浏览器业务。
test('媒体掉线后自动重新授权，迟到回调不能关闭新连接或重放输入', async (context) => {
  const h = harness(context);
  await h.flush();
  h.connect(0);
  h.connection.send(
    JSON.stringify({
      type: 'command',
      commandId: 'once',
      command: { type: 'browser.input', action: 'press', value: 'Enter' },
    }),
  );
  const staleClose = h.sockets[0]!.onclose;
  h.sockets[1]!.close();
  assert.equal(h.states.at(-1), 'reconnecting');
  await h.tick(1000);
  h.connect(2);
  assert.equal(h.requests(), 2);
  assert.notEqual(h.sockets[0]!.sent[0].token, h.sockets[2]!.sent[0].token);
  assert.equal(
    h.sockets[2]!.sent.filter((m) => m.type === 'command').length,
    0,
  );
  staleClose?.();
  assert.equal(h.connection.readyState, 1);
  h.connection.close();
  await h.tick(60000);
  assert.equal(h.requests(), 2);
});

// 范围：控制握手和媒体首帧均有界；静态页面收到首帧后不按帧率断开。
test('握手及首帧超时会重连，静态画面不会被误判为失联', async (context) => {
  const h = harness(context);
  await h.flush();
  await h.tick(10000);
  assert.equal(h.states.at(-1), 'reconnecting');
  await h.tick(1000);
  h.sockets[1]!.open();
  h.sockets[1]!.receive({ type: 'state', mode: 'HUMAN' });
  h.sockets[2]!.open();
  await h.tick(15000);
  assert.equal(h.states.at(-1), 'reconnecting');
  await h.tick(2000);
  h.connect(3);
  await h.tick(120000);
  assert.equal(h.requests(), 3);
  assert.equal(h.connection.readyState, 1);
});

// 范围：业务完成请求响应丢失后只查询结果，不再发送 complete；不证明业务副作用回滚。
test('交还途中断线仅重新查询完成状态，不重复提交交还', async (context) => {
  const h = harness(context);
  await h.flush();
  h.connect(0);
  h.connection.send(JSON.stringify({ type: 'complete', confirmedItems: [] }));
  h.reply(200, { state: { type: 'completed' } });
  h.sockets[0]!.close();
  await h.tick(1000);
  await h.tick(60000);
  assert.equal(h.requests(), 2);
  assert.equal(h.sockets.length, 2);
  assert.equal(h.messages.at(-1).type, 'completed');
  assert.equal(
    h.sockets[0]!.sent.filter((m) => m.type === 'complete').length,
    1,
  );
});

// 范围：已失效或无权访问的处理链接停止自动重试，不通过重连延长权限。
test('处理链接已结束时停止重试', async (context) => {
  const h = harness(context);
  await h.flush();
  h.connect(0);
  h.reply(410, { message: '处理已结束' });
  h.sockets[0]!.close();
  await h.tick(1000);
  await h.tick(120000);
  assert.equal(h.requests(), 2);
  assert.equal(h.states.at(-1), 'closed');
});
