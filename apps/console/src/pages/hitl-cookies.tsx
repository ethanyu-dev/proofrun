import { useState } from 'react';
import type { NodeCommand } from '@proofrun/contracts';

/** Cookie 只发往当前 HITL 的任务站点；敏感值不写入 URL 或浏览器存储。 */
export function HitlCookies({
  targetUrl,
  disabled,
  submit,
}: {
  targetUrl: string;
  disabled: boolean;
  submit: (commands: NodeCommand['command'][]) => boolean;
}) {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [refresh, setRefresh] = useState(true);
  const [httpOnly, setHttpOnly] = useState(true);
  return (
    <details>
      <summary>通过 Cookie 登录</summary>
      <p className="note">
        目标站点：{new URL(targetUrl).origin}。填写已授权账号的有效
        Cookie，可逐项添加。写入后可刷新远端页面，确认登录状态再继续任务。
      </p>
      <form
        className="control-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (
            submit([
              {
                type: 'browser.cookies.set',
                url: targetUrl,
                name,
                value,
                httpOnly,
              },
              ...(refresh
                ? [{ type: 'browser.act' as const, action: 'reload' as const }]
                : []),
            ])
          )
            setValue('');
        }}
      >
        <label>
          Cookie 名称（key）
          <input
            required
            autoComplete="off"
            maxLength={256}
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={disabled}
          />
        </label>
        <label>
          Cookie 值（value）
          <input
            type="password"
            autoComplete="off"
            maxLength={4096}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={disabled}
          />
        </label>
        <label className="hitl-cookie-option">
          <input
            type="checkbox"
            checked={httpOnly}
            onChange={(e) => setHttpOnly(e.target.checked)}
            disabled={disabled}
          />
          HttpOnly（站点脚本需要读取时取消）
        </label>
        <label className="hitl-cookie-option">
          <input
            type="checkbox"
            checked={refresh}
            onChange={(e) => setRefresh(e.target.checked)}
            disabled={disabled}
          />
          写入成功后刷新远端页面（多项 Cookie 可在最后一项勾选）
        </label>
        <p className="note">
          作用于当前站点主机及根路径 /，SameSite=Lax，HTTPS 下启用
          Secure。提交后等待操作完成再继续；保存登录状态仍遵循本任务设置。
        </p>
        <button
          className="button button-secondary"
          disabled={disabled || !name}
        >
          {refresh ? '写入 Cookie 并刷新' : '写入 Cookie'}
        </button>
      </form>
    </details>
  );
}
