import { useEffect, useState } from 'react';
import { ApiClient, errorMessage } from '../api';
import { ErrorNotice } from '../components/ui';
import { HitlPage } from './hitl';

/** 准入与初次导航完成后才挂载共用操作界面，启动期间也允许明确关闭。 */
export function NodeProfilePage({ api, id }: { api: ApiClient; id: string }) {
  const [status, setStatus] = useState<{
    ready: boolean;
    closed: boolean;
    closing: boolean;
    saveStatus: 'saved' | 'newer' | null;
  }>();
  const [error, setError] = useState<string>();
  const [closing, setClosing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setError(undefined);
    const read = async () => {
      try {
        const value = await api.json<NonNullable<typeof status>>(
          `/v1/node-profiles/${id}`,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setStatus(value);
        if (!value.ready && !value.closed)
          timer = setTimeout(() => void read(), 750);
      } catch (e) {
        if (!controller.signal.aborted) setError(errorMessage(e));
      }
    };
    void read();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [api, id, attempt]);
  if (status?.ready && !closing) return <HitlPage api={api} id={id} />;
  return (
    <section className="panel" aria-label="节点默认 profile">
      <h1>
        {status?.closed
          ? '维护会话已关闭'
          : status?.closing || closing
            ? '正在关闭浏览器…'
            : '正在打开维护浏览器…'}
      </h1>
      <p>
        {status?.closed
          ? status.saveStatus === 'saved'
            ? '节点默认 profile 已保存。'
            : status.saveStatus === 'newer'
              ? '已保留较新的节点默认 profile。'
              : '浏览器已关闭，没有确认发布新的节点默认 profile。'
          : '浏览器打开后可前往网页、完成登录，再保存为节点默认模板。'}
      </p>
      <ErrorNotice message={error} />
      <div className="page-actions">
        {error && (
          <button
            className="button button-secondary"
            onClick={() => setAttempt((n) => n + 1)}
          >
            重新读取状态
          </button>
        )}
        {!status?.closed && (
          <button
            className="button button-secondary"
            disabled={closing}
            onClick={async () => {
              setClosing(true);
              try {
                await api.json(
                  `/v1/node-profiles/${id}/close`,
                  new AbortController().signal,
                  {},
                );
                setAttempt((n) => n + 1);
              } catch (e) {
                setError(errorMessage(e));
                setClosing(false);
              }
            }}
          >
            不保存并关闭
          </button>
        )}
        <a className="button button-secondary" href="#/nodes">
          返回节点管理
        </a>
      </div>
    </section>
  );
}
