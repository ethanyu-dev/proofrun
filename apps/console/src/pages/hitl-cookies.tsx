import { useState } from 'react';
import type { NodeCommand } from '@proofrun/contracts';
import type { BatchResult } from './hitl-input';
import {
  COOKIE_LIMIT,
  cookieCommands,
  type CookieEntry,
} from './hitl-cookie-command';

/** 默认展开登录入口；批量写完才刷新，命令回执与站点登录状态分别表达。 */
export function HitlCookies({
  targetUrl,
  disabled,
  submit,
}: {
  targetUrl: string;
  disabled: boolean;
  submit: (
    commands: NodeCommand['command'][],
    settled: (result: BatchResult) => void,
  ) => boolean;
}) {
  const [entries, setEntries] = useState<CookieEntry[]>([
    { name: '', value: '', httpOnly: true },
  ]);
  const [refresh, setRefresh] = useState(true);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  const locked = disabled || pending;
  const update = (index: number, change: Partial<CookieEntry>) => {
    setEntries((rows) =>
      rows.map((row, i) => (i === index ? { ...row, ...change } : row)),
    );
    setError('');
    setResult('');
  };
  return (
    <section className="hitl-cookies" aria-label="通过 Cookie 登录">
      <h2>通过 Cookie 登录</h2>
      <p className="note">
        {new URL(targetUrl).hostname} · 填写已授权账号的全部登录
        Cookie，统一写入后刷新。
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setError('');
          setResult('');
          try {
            const commands = cookieCommands(targetUrl, entries, refresh);
            setPending(true);
            if (
              submit(commands, (outcome) => {
                setPending(false);
                if (outcome === 'succeeded') {
                  setResult(
                    refresh
                      ? 'Cookie 已写入，刷新命令已完成。请在上方画面确认登录账号，再继续任务。'
                      : 'Cookie 已写入。请刷新远端页面并确认登录账号。',
                  );
                } else
                  setError(
                    'Cookie 写入或刷新未全部确认。请重新连接检查页面，不要重复提交。',
                  );
              })
            )
              setEntries((rows) => rows.map((row) => ({ ...row, value: '' })));
            else setPending(false);
          } catch (cause) {
            setPending(false);
            setError(
              cause instanceof Error ? cause.message : 'Cookie 格式有误',
            );
          }
        }}
      >
        <div className="hitl-cookie-entries">
          {entries.map((entry, index) => (
            <div className="hitl-cookie-row" key={index}>
              <label>
                名称（key）
                <input
                  aria-label={`Cookie ${index + 1} 名称`}
                  required
                  autoComplete="off"
                  maxLength={256}
                  value={entry.name}
                  onChange={(e) => update(index, { name: e.target.value })}
                  disabled={locked}
                  placeholder="如 token"
                />
              </label>
              <label>
                值（value）
                <input
                  aria-label={`Cookie ${index + 1} 值`}
                  required
                  type="password"
                  autoComplete="off"
                  maxLength={4096}
                  value={entry.value}
                  onChange={(e) => update(index, { value: e.target.value })}
                  disabled={locked}
                />
              </label>
              <label className="hitl-cookie-option">
                <input
                  type="checkbox"
                  checked={entry.httpOnly}
                  onChange={(e) =>
                    update(index, { httpOnly: e.target.checked })
                  }
                  disabled={locked}
                />
                HttpOnly
              </label>
              <button
                type="button"
                className="button button-small button-secondary"
                aria-label={`移除 Cookie ${index + 1}`}
                disabled={locked || entries.length === 1}
                onClick={() => {
                  setEntries((rows) => rows.filter((_, i) => i !== index));
                  setResult('');
                }}
              >
                移除
              </button>
            </div>
          ))}
        </div>
        <div className="hitl-cookie-options">
          <button
            type="button"
            className="button button-small button-secondary"
            disabled={locked || entries.length >= COOKIE_LIMIT}
            onClick={() => {
              setEntries((rows) => [
                ...rows,
                { name: '', value: '', httpOnly: true },
              ]);
              setResult('');
            }}
          >
            ＋ 添加一项
          </button>
          <label className="hitl-cookie-option">
            <input
              type="checkbox"
              checked={refresh}
              onChange={(e) => setRefresh(e.target.checked)}
              disabled={locked}
            />
            全部写入后刷新
          </label>
          <button className="button button-primary" disabled={locked}>
            {pending
              ? '正在写入…'
              : refresh
                ? '写入 Cookie 并刷新'
                : '写入 Cookie'}
          </button>
        </div>
        {result && (
          <p role="status" className="hitl-cookie-result">
            {result}
          </p>
        )}
        {error && (
          <p role="alert" className="error-notice">
            {error}
          </p>
        )}
      </form>
      <details className="hitl-cookie-help">
        <summary>Cookie 属性与登录说明</summary>
        <p className="note">
          HttpOnly 请与原 Cookie
          一致：勾选后站点脚本无法读取。当前写入仅限目标主机、路径
          /、SameSite=Lax，HTTPS 下启用
          Secure。写入成功不等于登录成功；如果刷新后仍未登录，请核对有效期、账号及所需
          Cookie，也可直接在画面中登录。
        </p>
      </details>
    </section>
  );
}
