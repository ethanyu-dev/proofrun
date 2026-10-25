import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { Window } from 'happy-dom';

/** 采用控制台的 React；DOM 夹具只验证交互契约，不代表真实浏览器或 API 验收。 */
const require = createRequire(
  new URL('../../apps/console/package.json', import.meta.url),
);

// 范围：下拉键盘选择、清空筛选、禁用和表单值；不覆盖真实浏览器菜单定位或后端筛选。
test('下拉保留协议值，弹窗保护忙碌操作并归还焦点', async () => {
  const window = new Window({ url: 'http://localhost' });
  const values: Record<string, unknown> = {
    window,
    document: window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const key of [
    'HTMLFormElement',
    'HTMLButtonElement',
    'HTMLElement',
    'HTMLInputElement',
    'HTMLSelectElement',
    'Element',
    'Node',
    'NodeFilter',
    'DocumentFragment',
    'MutationObserver',
    'ResizeObserver',
    'CustomEvent',
    'Event',
    'KeyboardEvent',
  ])
    values[key] = window[key as keyof Window];
  values.getComputedStyle = window.getComputedStyle.bind(window);
  values.requestAnimationFrame = window.requestAnimationFrame.bind(window);
  values.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
  const previous = new Map(
    Object.keys(values).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(values))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  const { createElement: h, act, useState } = require('react');
  const { createRoot } = require('react-dom/client');
  const { SelectField, SelectItem, ALL_FILTER_VALUE } =
    await import('../../apps/console/src/components/select-field.tsx');
  const { Modal } = await import('../../apps/console/src/components/modal.tsx');
  const { Button } =
    await import('../../apps/console/src/components/ui/button.tsx');
  const container = window.document.createElement('div');
  window.document.body.append(container);
  const root = createRoot(container);
  const changes: string[] = [];
  function Field() {
    const [value, setValue] = useState(ALL_FILTER_VALUE);
    return h(
      'form',
      null,
      h(
        SelectField,
        {
          label: '执行状态',
          name: 'state',
          value,
          onValueChange: (next: string) => {
            changes.push(next);
            setValue(next);
          },
        },
        h(SelectItem, { value: ALL_FILTER_VALUE }, '全部'),
        h(SelectItem, { value: 'RUNNING' }, '执行中'),
      ),
    );
  }
  try {
    await act(async () => root.render(h(Field)));
    const trigger = window.document.querySelector('[role="combobox"]')!;
    await act(async () => {
      trigger.dispatchEvent(
        new window.KeyboardEvent('keydown', {
          key: 'ArrowDown',
          bubbles: true,
        }),
      );
    });
    assert.ok(window.document.querySelector('[role="listbox"]'));
    const running = [
      ...window.document.querySelectorAll('[role="option"]'),
    ].find((item) => item.textContent === '执行中')!;
    await act(async () => {
      (running as unknown as HTMLElement).focus();
      running.dispatchEvent(
        new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    assert.deepEqual(changes, ['RUNNING']);
    assert.equal(trigger.textContent, '执行中');
    assert.equal(
      (container.querySelector('select') as unknown as HTMLSelectElement).value,
      'RUNNING',
    );
    await act(async () =>
      trigger.dispatchEvent(
        new window.KeyboardEvent('keydown', {
          key: 'ArrowDown',
          bubbles: true,
        }),
      ),
    );
    const all = [...window.document.querySelectorAll('[role="option"]')].find(
      (item) => item.textContent === '全部',
    )!;
    await act(async () =>
      all.dispatchEvent(
        new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      ),
    );
    assert.equal(changes.at(-1), ALL_FILTER_VALUE);
    await act(async () =>
      root.render(
        h(
          SelectField,
          { label: '禁用字段', disabled: true, value: 'RUNNING' },
          h(SelectItem, { value: 'RUNNING' }, '执行中'),
        ),
      ),
    );
    assert.equal(window.document.querySelector('button')!.disabled, true);

    // 范围：受控弹窗忙碌时不关闭，Escape 关闭后归还焦点；不覆盖真实业务请求和屏幕阅读器。
    let closed = 0;
    const opener = window.document.createElement('button');
    window.document.body.append(opener);
    opener.focus();
    function DialogFixture({ busy }: { busy: boolean }) {
      const [open, setOpen] = useState(true);
      return open
        ? h(
            Modal,
            {
              title: '取消任务',
              description: '测试操作',
              busy,
              close: () => {
                closed++;
                setOpen(false);
              },
            },
            h(Button, { 'data-dialog-cancel': true }, '返回'),
          )
        : null;
    }
    await act(async () => root.render(h(DialogFixture, { busy: true })));
    assert.ok(window.document.querySelector('[role="dialog"]'));
    await act(async () =>
      window.document.activeElement!.dispatchEvent(
        new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    );
    assert.equal(closed, 0);
    await act(async () => root.render(h(DialogFixture, { busy: false })));
    await act(async () =>
      window.document.activeElement!.dispatchEvent(
        new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(closed, 1);
    assert.equal(window.document.querySelector('[role="dialog"]'), null);
    assert.equal(window.document.activeElement, opener);
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
