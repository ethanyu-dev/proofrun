import { IdentityField } from './identity-catalog-editor';
import {
  MAX_IDENTITY_COOKIES,
  newCookieDraft,
  type CookieDraft,
} from '../identity-cookies';

/** Cookie 只在当前表单驻留；编辑已有身份时先明确选择替换或清空，绝不回显原凭据。 */
export function IdentityCookieEditor({
  rows,
  change,
  editing,
  configured,
}: {
  rows: CookieDraft[] | null;
  change: (rows: CookieDraft[] | null) => void;
  editing: boolean;
  configured: boolean;
}) {
  const patch = (id: string, value: Partial<CookieDraft>) =>
    change(rows!.map((row) => (row.id === id ? { ...row, ...value } : row)));
  return (
    <section
      className="library-section cookie-editor"
      aria-labelledby="cookie-heading"
    >
      <div className="library-section-heading">
        <div>
          <h2 id="cookie-heading">
            Cookies <span className="library-optional">可选</span>
          </h2>
          <p>逐项填写登录 Cookie；暂不配置时，可由人工登录准备身份。</p>
        </div>
        {rows !== null && (
          <button
            type="button"
            className="button button-secondary"
            disabled={rows.length >= MAX_IDENTITY_COOKIES}
            onClick={() => change([...rows, newCookieDraft()])}
          >
            ＋ 添加 Cookie
          </button>
        )}
      </div>
      {rows === null ? (
        <div className="cookie-preserved">
          <div>
            <strong>
              {configured ? '已配置 Cookies' : '暂未配置 Cookies'}
            </strong>
            <p>已有凭据不回显，直接保存会保留当前配置。</p>
          </div>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => change([newCookieDraft()])}
          >
            {configured ? '替换 Cookies' : '添加 Cookie'}
          </button>
        </div>
      ) : (
        <>
          <div className="cookie-rows">
            {rows.map((row, index) => (
              <div
                className="cookie-form-row"
                key={row.id}
                role="group"
                aria-label={`Cookie ${index + 1}`}
              >
                <span className="cookie-row-number" aria-hidden="true">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <IdentityField label="Name">
                  <input
                    aria-label={`Cookie ${index + 1} Name`}
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={256}
                    value={row.name}
                    placeholder="例如 session"
                    onChange={(event) =>
                      patch(row.id, { name: event.target.value })
                    }
                  />
                </IdentityField>
                <IdentityField label="Value">
                  <input
                    aria-label={`Cookie ${index + 1} Value`}
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={4096}
                    value={row.value}
                    placeholder="填写 Cookie 值"
                    onChange={(event) =>
                      patch(row.id, { value: event.target.value })
                    }
                  />
                </IdentityField>
                <div className="cookie-switch-field">
                  <span>HttpOnly</span>
                  <button
                    type="button"
                    className="cookie-switch"
                    role="switch"
                    aria-checked={row.httpOnly}
                    aria-label={`Cookie ${index + 1} HttpOnly`}
                    onClick={() => patch(row.id, { httpOnly: !row.httpOnly })}
                  >
                    <span />
                  </button>
                </div>
                <button
                  type="button"
                  className="text-button cookie-remove"
                  aria-label={`删除 Cookie ${index + 1}`}
                  onClick={() =>
                    change(rows.filter((item) => item.id !== row.id))
                  }
                >
                  删除
                </button>
              </div>
            ))}
          </div>
          {!rows.length && (
            <p className="cookie-empty" role="status">
              {editing
                ? '保存后将清空原有 Cookies。'
                : '未添加 Cookies，可稍后通过人工登录准备。'}
            </p>
          )}
          <div className="cookie-editor-footer">
            <span className="muted">
              {rows.length} / {MAX_IDENTITY_COOKIES} 项 · 仅用于测试地址所在主机
            </span>
            <div className="page-actions">
              {editing && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => change(null)}
                >
                  保留原配置
                </button>
              )}
              {rows.length > 0 && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => change([])}
                >
                  清空 Cookies
                </button>
              )}
            </div>
          </div>
          {editing && (
            <p className="cookie-replacement-note">
              保存新的 Cookies 会替换原有配置，并重新建立身份基准。
            </p>
          )}
        </>
      )}
    </section>
  );
}
