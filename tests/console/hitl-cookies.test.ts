import assert from 'node:assert/strict';
import test from 'node:test';
import { validateHitlClient } from '../../contracts/src/index.ts';
import {
  cookieCommands,
  COOKIE_LIMIT,
} from '../../apps/console/src/pages/hitl-cookie-command.ts';
import { screenPoint } from '../../apps/console/src/pages/hitl-screen.ts';

// 范围：使用真实协议验证多 Cookie 先写后刷新，保持属性和值；不连接网站或判定登录成功。
test('Cookie 批量命令符合协议且只在最后刷新', () => {
  const entries = [
    { name: 'token', value: 'abc%20def==', httpOnly: false },
    { name: 'session', value: 'second-value', httpOnly: true },
  ];
  const commands = cookieCommands(
    'https://example.com/referral',
    entries,
    true,
  );
  assert.equal(commands.length, 3);
  for (const command of commands)
    assert.equal(
      validateHitlClient({
        type: 'command',
        commandId: crypto.randomUUID(),
        command,
      }),
      true,
    );
  assert.deepEqual(
    commands.slice(0, 2),
    entries.map((entry) => ({
      type: 'browser.cookies.set',
      url: 'https://example.com/referral',
      ...entry,
    })),
  );
  assert.deepEqual(commands[2], { type: 'browser.act', action: 'reload' });
  assert.equal(cookieCommands('https://example.com', entries, false).length, 2);
});

// 范围：错误在发送前拒绝且不回显敏感值；不改变服务端校验规则或修复过期 Cookie。
test('拒绝请求头、非法字符、重复名称和超过队列容量的 Cookie', () => {
  for (const entry of [
    { name: 'token=secret', value: 'secret' },
    { name: 'token', value: 'secret;other=value' },
    { name: 'token', value: ' secret ' },
    { name: 'token', value: '中文' },
    { name: 'token', value: '"secret"' },
    { name: 'token', value: '' },
  ]) {
    assert.throws(
      () =>
        cookieCommands(
          'https://example.com',
          [{ ...entry, httpOnly: true }],
          true,
        ),
      (e: Error) => !e.message.includes('secret'),
    );
  }
  const entry = { name: 'token', value: 'secret', httpOnly: true };
  assert.throws(
    () => cookieCommands('https://example.com', [entry, entry], false),
    /重复/,
  );
  assert.throws(
    () =>
      cookieCommands(
        'https://example.com',
        Array(COOKIE_LIMIT + 1).fill(entry),
        true,
      ),
    /1–7/,
  );
  assert.throws(
    () => cookieCommands('https://user:password@example.com', [entry], true),
    /地址无效/,
  );
  const max = Array.from({ length: COOKIE_LIMIT }, (_, i) => ({
    ...entry,
    name: `token${i}`,
  }));
  assert.equal(cookieCommands('https://example.com', max, true).length, 8);
});

// 范围：缩放和边缘坐标映射不越界；不验证真实页面点击命中或鼠标设备。
test('画面缩放与边缘坐标限制在远端视口', () => {
  const rect = { left: 24, top: 12, width: 640, height: 360 };
  assert.deepEqual(screenPoint(344, 192, rect, 1280, 720), { x: 640, y: 360 });
  assert.deepEqual(screenPoint(0, 0, rect, 1280, 720), { x: 0, y: 0 });
  assert.deepEqual(screenPoint(664, 372, rect, 1280, 720), { x: 1279, y: 719 });
});
