import { useState } from 'react';
import type { NodeCommand } from '@proofrun/contracts';

/** 地址框是人工指定的目的地，不将任务 URL 冒充远端当前地址。 */
export function HitlNavigation({
  targetUrl,
  disabled,
  submit,
}: {
  targetUrl?: string | undefined;
  disabled: boolean;
  submit: (command: NodeCommand['command']) => boolean;
}) {
  const [url, setUrl] = useState(targetUrl ?? '');
  const [error, setError] = useState('');
  return (
    <form
      className="hitl-navigation"
      onSubmit={(event) => {
        event.preventDefault();
        try {
          const target = new URL(url);
          if (
            !['http:', 'https:'].includes(target.protocol) ||
            target.username ||
            target.password
          )
            throw new Error();
          setError('');
          submit({
            type: 'browser.act',
            action: 'navigate',
            target: target.href,
          });
        } catch {
          setError('请输入不含账号密码的完整 HTTP/HTTPS 网址');
        }
      }}
    >
      <label>
        前往远端网址
        <input
          type="url"
          required
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={disabled}
          placeholder="https://example.com/"
        />
      </label>
      <button className="button button-secondary" disabled={disabled}>
        前往
      </button>
      <button
        type="button"
        className="button button-secondary"
        disabled={disabled}
        onClick={() => submit({ type: 'browser.act', action: 'reload' })}
      >
        刷新远端页面
      </button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}

/** 倒计时只展示已有授权期限，不延长后台任务或介入权限。 */
export function remainingTime(expiresAt: string, now: number): string {
  const seconds = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
  return seconds > 0
    ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
    : '已到期';
}
