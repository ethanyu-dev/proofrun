import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiClient, errorMessage } from '../api';
import { ErrorNotice } from './ui';
import {
  readSavedCredential,
  readRestorableCredential,
  saveCredential,
  clearSavedCredential,
  suspendCredentialRestore,
} from '../credential-storage';

/** 沿用手动连接的只读探测接口，验证通过前不挂载业务页面。 */
const CONNECTION_CHECK_PATH = '/v1/tasks?limit=1';

/** 自动恢复仅在挂载时发起；取消或卸载后忽略迟到结果，避免重新建立已断开的连接。 */
export function Connect({
  onConnect,
  autoRestore,
}: {
  /** 当前页面主动断开后，即使浏览器无法保存标记，也不得立即自动重连。 */
  autoRestore: boolean;
  /** 仅在控制面完成凭据验证后交接客户端。 */
  onConnect: (api: ApiClient, saved: boolean) => void;
}) {
  const [token, setToken] = useState(readSavedCredential);
  const [restoreToken] = useState(() =>
    autoRestore ? readRestorableCredential() : '',
  );
  const [restoring, setRestoring] = useState(Boolean(restoreToken));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  useEffect(() => {
    if (!restoreToken) return;
    const controller = new AbortController();
    active.current = controller;
    const api = new ApiClient(restoreToken);
    void api.json(CONNECTION_CHECK_PATH, controller.signal).then(
      () => {
        if (!controller.signal.aborted) onConnect(api, true);
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setError(errorMessage(error));
        setRestoring(false);
      },
    );
    // StrictMode 重挂载和切换到独立处理页时均需中止旧验证。
    return () => controller.abort();
  }, [restoreToken, onConnect]);
  /** 只有手动验证成功才更新本地凭据，并解除主动断开设置的恢复禁用标记。 */
  const connect = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    const controller = new AbortController();
    active.current = controller;
    setPending(true);
    setError(undefined);
    const api = new ApiClient(token.trim());
    try {
      await api.json(CONNECTION_CHECK_PATH, controller.signal);
      if (!controller.signal.aborted)
        onConnect(api, saveCredential(token.trim()));
    } catch (error) {
      if (!controller.signal.aborted) setError(errorMessage(error));
    } finally {
      if (!controller.signal.aborted) setPending(false);
    }
  };
  if (restoring)
    return (
      <section className="connect-page" aria-busy="true">
        <h1>正在恢复连接…</h1>
        <p className="muted" role="status">
          正在验证已保存的凭据，完成后返回当前页面。
        </p>
        <button
          className="button button-secondary"
          onClick={() => {
            active.current?.abort();
            if (!suspendCredentialRestore())
              setError('浏览器无法保存断开状态；请在站点设置中清除本地数据。');
            setRestoring(false);
          }}
        >
          取消自动连接
        </button>
      </section>
    );
  return (
    <section className="connect-page">
      <p className="announcement">ProofRun · 浏览器验证执行平台</p>
      <h1>
        让每一次验证，
        <br />
        都有据可查。
      </h1>
      <p className="muted">连接控制面，查看任务、节点和验证报告。</p>
      <form className="panel connect-form" onSubmit={connect}>
        <label htmlFor="admin-token">访问凭据</label>
        <input
          id="admin-token"
          type="password"
          autoComplete="off"
          value={token}
          maxLength={512}
          onChange={(event) => setToken(event.target.value)}
          required
          disabled={pending}
        />
        <p className="muted note">
          连接成功后，刷新或再次打开会自动恢复连接。主动断开后仅自动填入凭据。
        </p>
        <ErrorNotice message={error} />
        <button
          className="button button-primary"
          disabled={pending || !token.trim()}
        >
          {pending ? '连接中…' : '连接控制面'} <span aria-hidden="true">↗</span>
        </button>
        <button
          type="button"
          className="button button-secondary"
          disabled={pending}
          onClick={() => {
            if (clearSavedCredential()) {
              setToken('');
              setError(undefined);
            } else {
              setError(
                '浏览器无法清除已保存的凭据，请在站点设置中清除本地数据。',
              );
            }
          }}
        >
          清除已保存凭据
        </button>
      </form>
    </section>
  );
}
