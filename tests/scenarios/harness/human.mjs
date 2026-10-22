import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

/** 只在 E10 的固定测试页面输入验证码；不承担通用账号登录或 Console UI 验收。 */
const require = createRequire(
  new URL('../../../apps/api/package.json', import.meta.url),
);
const WebSocket = require('ws');
const HUMAN_MS = 90_000;

/** 真正通过 HITL WebSocket 交还控制权；管理员直接恢复不能代替人工确认。 */
export async function assist(control, intervention, sampleId, getState) {
  const socket = new WebSocket(
    control.origin.replace(/^http/, 'ws') + '/v1/hitl/connect',
    { origin: control.origin },
  );
  const messages = [];
  let failure;
  socket.on('error', () => {
    failure = new Error('HITL_TRANSPORT_FAILED');
  });
  socket.on('message', (bytes) => {
    const message = JSON.parse(bytes.toString());
    if (message.type !== 'frame') messages.push(message);
  });
  const end = Date.now() + HUMAN_MS;
  const until = async (predicate) => {
    while (Date.now() < end) {
      const value = predicate();
      if (value) return value;
      const rejected = messages.find((m) => m.type === 'error');
      if (failure || rejected)
        throw (
          failure ??
          new Error(
            typeof rejected.code === 'string' &&
              /^[A-Z_]{1,80}$/.test(rejected.code)
              ? `HITL_REJECTED_${rejected.code}`
              : 'HITL_REJECTED',
          )
        );
      await delay(50);
    }
    throw new Error('HITL_TIMEOUT');
  };
  try {
    await until(() => socket.readyState === WebSocket.OPEN);
    socket.send(
      JSON.stringify({
        type: 'authenticate',
        id: intervention.id,
        token: intervention.path.split('/').at(-1),
      }),
    );
    const state = await until(() =>
      messages.find((m) => m.type === 'state' && m.mode === 'HUMAN'),
    );
    if (
      !state.targetUrl ||
      new URL(state.targetUrl).pathname !== `/runs/${sampleId}`
    )
      throw new Error('HITL_WRONG_TARGET');
    const fixture = await getState();
    if (!fixture.loggedIn) {
      for (const operation of [
        { action: 'click', x: 130, y: 84 },
        { action: 'text', value: fixture.code },
        { action: 'click', x: 85, y: 145 },
      ]) {
        const commandId = randomUUID();
        socket.send(
          JSON.stringify({
            type: 'command',
            commandId,
            command: { type: 'browser.input', ...operation },
          }),
        );
        const result = await until(() =>
          messages.find(
            (m) => m.type === 'result' && m.commandId === commandId,
          ),
        );
        if (result.status !== 'SUCCEEDED') throw new Error('HITL_INPUT_FAILED');
      }
    }
    if (!(await getState()).loggedIn) throw new Error('HITL_LOGIN_UNCONFIRMED');
    socket.send(
      JSON.stringify({
        type: 'complete',
        confirmedItems: state.items.map((_, index) => index),
        // 无条件身份的普通交接应省略该字段；空数组仍会触发条件身份校验。
        ...(state.conditionKeys
          ? { confirmedConditionKeys: state.conditionKeys }
          : {}),
      }),
    );
    await until(() => messages.find((m) => m.type === 'completed'));
    return { completed: true, interventionId: intervention.id };
  } finally {
    socket.terminate();
  }
}
