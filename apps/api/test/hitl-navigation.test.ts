import assert from 'node:assert/strict';
import test from 'node:test';
import { validateHitlNavigation } from '../src/modules/hitl/navigation.js';

// 范围：导航白名单和 URL 协议；不验证真实网站可达性。
test('HITL 只允许网页导航和无额外参数的刷新', () => {
  validateHitlNavigation({ type: 'browser.act', action: 'reload' });
  validateHitlNavigation({
    type: 'browser.act',
    action: 'navigate',
    target: 'https://example.com/path?q=1',
  });
  for (const target of [
    'javascript:alert(1)',
    'file:///etc/passwd',
    'data:text/html,abc',
    'https://user:pass@example.com',
    '/relative',
    'not-a-url',
  ]) {
    assert.throws(
      () =>
        validateHitlNavigation({
          type: 'browser.act',
          action: 'navigate',
          target,
        }),
      /HTTP/,
    );
  }
  for (const command of [
    { type: 'browser.act' as const, action: 'tab.new' as const },
    { type: 'browser.act' as const, action: 'click' as const, target: 'a' },
    { type: 'browser.act' as const, action: 'reload' as const, value: 'extra' },
  ])
    assert.throws(() => validateHitlNavigation(command), /HTTP/);
});
