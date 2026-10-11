import { useEffect, useRef, useState } from 'react';
import { ApiClient, errorMessage } from '../api';
import { useResource } from '../use-resource';
import { Empty, ErrorNotice, PageHeader, RefreshBar } from '../components/ui';
import {
  IdentityCatalogEditor,
  IdentityField,
} from '../components/identity-catalog-editor';
import {
  IdentityCatalogSummary,
  IdentityUsage,
} from '../components/identity-overview';
import {
  emptyCatalog,
  identityWrite,
  type IdentityCatalog,
  type IdentitySettingsView,
  type IdentityMetrics,
} from '../identity-config';

/** 配置只手动刷新；统计可以轮询，不能用后台读取覆盖管理员正在编辑的草稿。 */
export function IdentitiesPage({ api }: { api: ApiClient }) {
  const settings = useResource<IdentitySettingsView>(
    api,
    '/v1/admin/identities/settings',
    false,
  );
  const catalog = useResource<
    IdentitySettingsView & { catalog: IdentityCatalog }
  >(api, '/v1/admin/identities', false);
  const metrics = useResource<IdentityMetrics>(
    api,
    '/v1/admin/identities/metrics',
  );
  const [notice, setNotice] = useState<string>();
  return (
    <>
      <PageHeader
        title="测试身份"
        description="配置登录身份、账号池与站点匹配规则，减少重复人工登录。"
      />
      {notice && (
        <p className="identity-notice" role="status">
          {notice}
        </p>
      )}
      <ErrorNotice message={settings.error} />
      {!settings.data ? (
        <Empty
          title={settings.loading ? '正在读取身份配置…' : '身份配置读取失败'}
        >
          <button className="text-button" onClick={settings.refresh}>
            重新读取
          </button>
        </Empty>
      ) : (
        <IdentitySettingsForm
          key={`${settings.data.revision}-${settings.updatedAt?.getTime()}`}
          api={api}
          settings={settings.data}
          catalog={catalog.data?.catalog}
          catalogError={catalog.error}
          catalogLoading={catalog.loading}
          edited={() => setNotice(undefined)}
          reload={() => {
            settings.refresh();
            catalog.refresh();
          }}
          saved={() => {
            setNotice(
              '配置已保存，对新建和重跑的任务立即生效。正在执行的任务保持原身份计划。',
            );
            settings.refresh();
            catalog.refresh();
          }}
          refreshed={catalog.refresh}
        />
      )}
      <RefreshBar {...metrics} />
      <ErrorNotice message={metrics.error} />
      {metrics.data && <IdentityUsage metrics={metrics.data} />}
    </>
  );
}

/** 令牌只驻留此表单，提交后清空；不存浏览器存储，也不从服务端取回明文。 */
export function IdentitySettingsForm({
  api,
  settings,
  catalog,
  catalogError,
  catalogLoading,
  reload,
  saved,
  refreshed,
  edited,
}: {
  api: ApiClient;
  settings: IdentitySettingsView;
  catalog: IdentityCatalog | undefined;
  catalogError: string | undefined;
  catalogLoading: boolean;
  reload: () => void;
  saved: () => void;
  refreshed: () => void;
  edited?: () => void;
}) {
  const [mode, setMode] = useState(settings.mode);
  const [url, setUrl] = useState(settings.url ?? '');
  const [token, setToken] = useState('');
  const [draft, setDraft] = useState<IdentityCatalog | null>(settings.catalog);
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [confirmReload, setConfirmReload] = useState(false);
  const active = useRef<AbortController | null>(null);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => () => active.current?.abort(), []);
  const changed = () => {
    edited?.();
    setDirty(true);
    setNotice(undefined);
    setError(undefined);
    setConfirmReload(false);
  };
  const canKeepToken =
    mode === 'http' &&
    settings.mode === 'http' &&
    settings.tokenConfigured &&
    url.trim() === settings.url;
  const perform = async (action: 'save' | 'test' | 'refresh') => {
    if (active.current) return;
    if (action !== 'refresh' && !form.current?.reportValidity()) return;
    const controller = new AbortController();
    active.current = controller;
    setPending(action);
    setError(undefined);
    setNotice(undefined);
    try {
      const body =
        action === 'refresh'
          ? {}
          : identityWrite(
              settings.revision,
              mode,
              url,
              token,
              draft ?? emptyCatalog(),
            );
      const path = action === 'save' ? 'settings' : action;
      const result = await api.json<{
        identities?: number;
        pools?: number;
        sites?: number;
      }>(`/v1/admin/identities/${path}`, controller.signal, body);
      if (controller.signal.aborted) return;
      if (action === 'save') {
        setToken('');
        setDirty(false);
        saved();
      } else {
        setNotice(
          `${action === 'refresh' ? '目录已刷新' : '配置验证通过'}：${result.identities} 个身份、${result.pools} 个账号池、${result.sites} 条规则。${action === 'test' ? '尚未保存；本次未执行网站登录。' : ''}`,
        );
        if (action === 'refresh') refreshed();
      }
    } catch (e) {
      if (!controller.signal.aborted) setError(errorMessage(e));
    } finally {
      if (!controller.signal.aborted) {
        active.current = null;
        setPending(undefined);
      }
    }
  };
  return (
    <form
      ref={form}
      className="identity-settings"
      onSubmit={(e) => {
        e.preventDefault();
        void perform('save');
      }}
    >
      <fieldset className="task-editor" disabled={!!pending}>
        <section
          className="panel identity-connection"
          aria-labelledby="identity-connection-heading"
        >
          <div className="section-heading">
            <div>
              <h2 id="identity-connection-heading">身份库配置</h2>
              <p className="muted">
                保存后即时生效。外部库目录由提供方维护，页面可查看和刷新。
              </p>
            </div>
            <span className="status">
              {dirty
                ? '有未保存修改'
                : settings.mode === 'environment'
                  ? '沿用部署配置'
                  : '页面配置生效中'}
            </span>
          </div>
          <IdentityField label="配置来源">
            <select
              value={mode}
              onChange={(e) => {
                const next = e.target.value as typeof mode;
                setMode(next);
                setToken('');
                if (next === 'local' && draft === null)
                  setDraft(structuredClone(catalog ?? emptyCatalog()));
                changed();
              }}
            >
              <option value="http">外部身份库</option>
              <option value="local">在页面维护</option>
              <option value="environment">使用部署配置</option>
            </select>
          </IdentityField>
          {mode === 'http' && (
            <>
              <div className="identity-form-grid">
                <IdentityField label="外部库地址">
                  <input
                    required
                    type="url"
                    maxLength={2048}
                    placeholder="https://identities.example.com/catalog"
                    value={url}
                    onChange={(e) => {
                      setUrl(e.target.value);
                      changed();
                    }}
                  />
                </IdentityField>
                <IdentityField
                  label={
                    canKeepToken ? '访问令牌（已配置，留空保留）' : '访问令牌'
                  }
                >
                  <input
                    required={!canKeepToken}
                    type="password"
                    maxLength={8192}
                    autoComplete="new-password"
                    spellCheck={false}
                    placeholder={
                      canKeepToken
                        ? '输入新令牌以更新'
                        : '填写外部库的 Bearer 令牌'
                    }
                    value={token}
                    onChange={(e) => {
                      setToken(e.target.value);
                      changed();
                    }}
                  />
                </IdentityField>
              </div>
              <p className="muted note">
                读取无密码、无 Cookie
                的身份目录。修改地址时须重新填写令牌；令牌不回显。
              </p>
            </>
          )}
          {mode === 'environment' && (
            <p className="muted wrap">
              保存后沿用服务部署时的身份配置。当前部署来源会在保存并重新读取后显示。
              {settings.mode === 'environment'
                ? settings.source === 'http'
                  ? ` 外部库：${settings.url}（令牌已配置）。`
                  : ' 当前为本地元数据目录。'
                : ''}
            </p>
          )}
          {mode === 'local' && (
            <p className="muted">
              在下方编辑身份、账号池与规则后统一保存。密码与 Cookie 由 Browser
              Node 的私有登录配方或外部凭据服务管理。
            </p>
          )}
        </section>
        {mode === 'local' ? (
          <section className="panel">
            <IdentityCatalogEditor
              catalog={draft ?? emptyCatalog()}
              change={(value) => {
                setDraft(value);
                changed();
              }}
            />
          </section>
        ) : (
          <section className="panel">
            <div className="section-heading">
              <div>
                <h2>当前生效目录</h2>
                <p className="muted">
                  {dirty
                    ? '以下为已保存配置的目录，不代表上方尚未保存的草稿。'
                    : '只读目录；选择“在页面维护”可复制已读取的目录进行编辑。'}
                </p>
              </div>
              <button
                type="button"
                className="button button-secondary"
                onClick={() => void perform('refresh')}
              >
                {pending === 'refresh' ? '刷新中…' : '刷新目录'}
              </button>
            </div>
            <ErrorNotice message={catalogError} />
            {catalog ? (
              <IdentityCatalogSummary catalog={catalog} />
            ) : (
              <p className="muted">
                {catalogLoading
                  ? '正在读取目录…'
                  : '目录暂不可用，可在上方修正连接配置。'}
              </p>
            )}
          </section>
        )}
        <div className="panel identity-save-bar">
          <div>
            <ErrorNotice message={error} />
            {notice && <p role="status">{notice}</p>}
            <p className="muted note">
              任务需选择指定身份、账号池或自动匹配；配置目录不会更改任务的登录模式。
            </p>
          </div>
          <div className="page-actions">
            <button
              type="button"
              className="button button-secondary"
              onClick={() => void perform('test')}
            >
              {pending === 'test'
                ? '验证中…'
                : mode === 'http'
                  ? '验证连接'
                  : '验证配置'}
            </button>
            <button type="submit" className="button button-primary">
              {pending === 'save' ? '保存中…' : '保存配置'}
            </button>
            <button
              type="button"
              className="text-button"
              onClick={() => {
                if (dirty && !confirmReload) setConfirmReload(true);
                else reload();
              }}
            >
              {confirmReload ? '确认放弃修改并重新读取' : '重新读取配置'}
            </button>
          </div>
        </div>
      </fieldset>
    </form>
  );
}
