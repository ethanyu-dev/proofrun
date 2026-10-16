import { useEffect, useRef, useState, type Ref } from 'react';
import { ApiClient, errorMessage } from '../api';
import { ErrorNotice } from './ui';

/** 节点默认模板独立于身份库；重复进入先恢复尚未关闭的维护会话。 */
export function NodeProfileStart({
  ref,
  api,
  nodeId,
  name,
  close,
}: {
  /** 由节点页定位面板，避免长列表中的入口与表单相隔一屏以上。 */
  ref?: Ref<HTMLElement>;
  api: ApiClient;
  nodeId: string;
  name: string;
  close: () => void;
}) {
  const [url, setUrl] = useState('');
  const [current, setCurrent] = useState<string>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string>();
  const active = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    active.current = controller;
    void api
      .json<{ id: string | null }>(
        `/v1/nodes/${encodeURIComponent(nodeId)}/profile`,
        controller.signal,
      )
      .then((value) => {
        if (!controller.signal.aborted) setCurrent(value.id ?? undefined);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorMessage(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => active.current?.abort();
  }, [api, nodeId]);
  return (
    <section
      ref={ref}
      tabIndex={-1}
      className="panel"
      aria-label="维护节点默认 profile"
    >
      <div className="section-heading">
        <h2>{name} · 默认 profile</h2>
        <button className="button button-secondary" onClick={close}>
          收起
        </button>
      </div>
      <p>
        打开网页并完成登录后，点击“保存并关闭”。后续新身份将复制此模板；已有身份基准保持原版本。
      </p>
      <ErrorNotice message={error} />
      {current ? (
        <a
          className="button button-primary"
          href={`#/node-profiles/${current}`}
        >
          继续维护会话
        </a>
      ) : (
        <form
          className="control-form"
          onSubmit={async (event) => {
            event.preventDefault();
            if (busy) return;
            const controller = new AbortController();
            active.current = controller;
            setBusy(true);
            setError(undefined);
            try {
              const result = await api.json<{ id: string }>(
                `/v1/nodes/${encodeURIComponent(nodeId)}/profile`,
                controller.signal,
                { url },
              );
              if (!controller.signal.aborted)
                location.hash = `/node-profiles/${result.id}`;
            } catch (e) {
              if (!controller.signal.aborted) setError(errorMessage(e));
            } finally {
              if (!controller.signal.aborted) setBusy(false);
            }
          }}
        >
          <label>
            首次打开的网址
            <input
              type="url"
              required
              maxLength={8192}
              placeholder="https://example.com/"
              value={url}
              disabled={busy}
              onChange={(event) => setUrl(event.target.value)}
            />
          </label>
          <button className="button button-primary" disabled={busy}>
            {busy ? '正在准备…' : '打开浏览器'}
          </button>
        </form>
      )}
    </section>
  );
}
