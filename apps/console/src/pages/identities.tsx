import { useEffect, useRef, useState } from 'react';
import { ApiClient, errorMessage } from '../api';
import { useResource } from '../use-resource';
import { Empty, ErrorNotice, PageHeader } from '../components/ui';
import { IdentityField } from '../components/identity-catalog-editor';
import { IdentityCookieEditor } from '../components/identity-cookie-editor';
import {
  identityCookiePayload,
  newCookieDraft,
  type CookieDraft,
} from '../identity-cookies';

/** 用户只编辑六个业务字段；内部引用与修订号仅用于安全保存，不作为表单字段。 */
export interface LibraryEntry {
  id: string;
  revision: number;
  url: string;
  name: string;
  type: string;
  description: string;
  concurrency: number;
  cookiesConfigured: boolean;
  baselineReady: boolean;
}

/** 配置不自动轮询，防止后台更新覆盖正在编辑的 Cookie 和账号描述。 */
export function IdentitiesPage({ api }: { api: ApiClient }) {
  const resource = useResource<{ identities: LibraryEntry[] }>(
    api,
    '/v1/admin/identity-library',
    false,
  );
  const [editing, setEditing] = useState<LibraryEntry | 'new'>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState('');
  const [deleting, setDeleting] = useState<string>();
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  const remove = async (entry: LibraryEntry) => {
    if (deleting !== entry.id) {
      setDeleting(entry.id);
      return;
    }
    active.current = new AbortController();
    setPending(true);
    setError(undefined);
    try {
      await api.json(
        '/v1/admin/identity-library/remove',
        active.current.signal,
        { id: entry.id, revision: entry.revision },
      );
      setDeleting(undefined);
      resource.refresh();
    } catch (error) {
      if (!active.current.signal.aborted) setError(errorMessage(error));
    } finally {
      if (!active.current.signal.aborted) setPending(false);
    }
  };
  return (
    <div className="identities-page">
      <PageHeader
        title="测试身份"
        description="Agent 根据 Case 选择账号，每个任务使用独立浏览器副本。"
      />
      <ErrorNotice message={resource.error ?? error} />
      {notice && <p role="status">{notice}</p>}
      {editing !== undefined ? (
        <IdentityForm
          key={editing === 'new' ? 'new' : `${editing.id}-${editing.revision}`}
          api={api}
          entry={editing === 'new' ? undefined : editing}
          cancel={() => setEditing(undefined)}
          saved={() => {
            setEditing(undefined);
            setNotice('身份已保存，对新建和重跑任务生效。');
            resource.refresh();
          }}
        />
      ) : (
        <>
          <div className="library-toolbar">
            <div>
              <h2>
                身份库{' '}
                <span className="library-count">
                  {resource.data?.identities.length ?? '—'}
                </span>
              </h2>
              <p className="muted">
                维护账号信息；只有人工处理成功后才更新浏览器基准。
              </p>
            </div>
            <div className="page-actions">
              <button
                className="button button-primary"
                onClick={() => {
                  setNotice('');
                  setEditing('new');
                }}
              >
                添加测试身份
              </button>
              <button
                className="button button-secondary"
                onClick={resource.refresh}
              >
                刷新
              </button>
            </div>
          </div>
          {!resource.data ? (
            <Empty
              title={resource.loading ? '正在读取身份…' : '身份读取失败'}
            />
          ) : !resource.data.identities.length ? (
            <Empty title="尚未添加测试身份">
              添加账号信息和 Cookies；无法自动准备的身份会交给人工处理。
            </Empty>
          ) : (
            <div className="library-cards">
              {resource.data.identities.map((entry) => (
                <section className="library-card" key={entry.id}>
                  <div className="library-card-heading">
                    <h2>{entry.name}</h2>
                    <span className="status">{entry.type || '未指定类型'}</span>
                  </div>
                  <dl className="facts">
                    <div>
                      <dt>测试地址</dt>
                      <dd className="wrap">{entry.url}</dd>
                    </div>
                    <div>
                      <dt>Cookies</dt>
                      <dd>
                        {entry.cookiesConfigured ? '已配置' : '未配置'}
                        {entry.baselineReady
                          ? ' · 已有人工确认的浏览器基准'
                          : ''}
                      </dd>
                    </div>
                    <div>
                      <dt>身份类型</dt>
                      <dd>{entry.type || '未指定'}</dd>
                    </div>
                    <div>
                      <dt>身份描述</dt>
                      <dd>{entry.description}</dd>
                    </div>
                    <div>
                      <dt>并发数</dt>
                      <dd>{entry.concurrency}</dd>
                    </div>
                  </dl>
                  <div className="page-actions">
                    <button
                      className="button button-secondary"
                      disabled={pending}
                      onClick={() => {
                        setNotice('');
                        setEditing(entry);
                      }}
                    >
                      编辑
                    </button>
                    <button
                      className="text-button"
                      disabled={pending}
                      onClick={() => void remove(entry)}
                    >
                      {deleting === entry.id ? '确认删除' : '删除'}
                    </button>
                  </div>
                </section>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Cookie 不回显；通过明确的编辑状态区分保留、替换与清空，修改后创建新基准版本。 */
export function IdentityForm({
  api,
  entry,
  saved,
  cancel,
}: {
  api: ApiClient;
  entry?: LibraryEntry | undefined;
  saved: () => void;
  cancel: () => void;
}) {
  const [url, setUrl] = useState(entry?.url ?? '');
  const [name, setName] = useState(entry?.name ?? '');
  const [type, setType] = useState(entry?.type ?? '');
  const [description, setDescription] = useState(entry?.description ?? '');
  const [concurrency, setConcurrency] = useState(entry?.concurrency ?? 1);
  const [cookies, setCookies] = useState<CookieDraft[] | null>(() =>
    entry ? null : [newCookieDraft()],
  );
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  const save = async () => {
    active.current = new AbortController();
    setPending(true);
    setError(undefined);
    try {
      const cookiePayload = identityCookiePayload(cookies, !!entry);
      await api.json('/v1/admin/identity-library', active.current.signal, {
        ...(entry ? { id: entry.id, revision: entry.revision } : {}),
        url,
        name,
        type,
        description,
        concurrency,
        ...(cookiePayload === undefined ? {} : { cookies: cookiePayload }),
      });
      if (!active.current.signal.aborted) {
        setCookies(null);
        saved();
      }
    } catch (error) {
      if (!active.current.signal.aborted) setError(errorMessage(error));
    } finally {
      if (!active.current.signal.aborted) setPending(false);
    }
  };
  return (
    <form
      className="library-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="library-form-heading">
        <div>
          <h2>{entry ? '编辑测试身份' : '添加测试身份'}</h2>
          <p className="muted">填写账号信息，帮助 Agent 选择合适的测试身份。</p>
        </div>
      </div>
      <fieldset className="task-editor" disabled={pending}>
        <section
          className="library-section"
          aria-labelledby="identity-basics-heading"
        >
          <div className="library-section-heading">
            <div>
              <h2 id="identity-basics-heading">基本信息</h2>
              <p>描述账号用途、权限和可同时执行的任务数量。</p>
            </div>
          </div>
          <div className="identity-form-grid">
            <IdentityField label="测试地址">
              <input
                type="url"
                required
                maxLength={2000}
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://example.com/app"
              />
            </IdentityField>
            <IdentityField label="身份名称">
              <input
                required
                maxLength={160}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="测试团队普通成员"
              />
            </IdentityField>
            <IdentityField label="身份类型（可选）">
              <input
                maxLength={100}
                value={type}
                onChange={(event) => setType(event.target.value)}
                placeholder="成员 / 管理员"
              />
            </IdentityField>
            <IdentityField label="并发数">
              <input
                type="number"
                required
                min={1}
                max={32}
                value={concurrency}
                onChange={(event) => setConcurrency(Number(event.target.value))}
              />
            </IdentityField>
          </div>
          <IdentityField label="身份描述">
            <textarea
              required
              rows={3}
              maxLength={2000}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="所属团队、权限、已开通能力及其他与测试有关的账号条件"
            />
          </IdentityField>
        </section>
        <IdentityCookieEditor
          rows={cookies}
          change={setCookies}
          editing={!!entry}
          configured={entry?.cookiesConfigured ?? false}
        />
        <div className="library-form-footer">
          <ErrorNotice message={error} />
          <div className="page-actions">
            <button className="button button-primary" type="submit">
              {pending ? '保存中…' : '保存身份'}
            </button>
            <button
              className="button button-secondary"
              type="button"
              onClick={cancel}
            >
              取消
            </button>
          </div>
        </div>
      </fieldset>
    </form>
  );
}
