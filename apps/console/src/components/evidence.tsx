import { useEffect, useRef, useState } from 'react';
import type { VerificationReport } from '@proofrun/contracts';
import { ApiClient, errorMessage } from '../api';
import { ErrorNotice } from './ui';

/** 证据身份与摘要来自已存档报告，下载地址始终由同源接口构造。 */
type Artifact = VerificationReport['artifacts'][number];

/** 文本以纯文本展示；切换证据时取消旧读取并释放对象地址。 */
export function Evidence({
  api,
  artifact,
  close,
}: {
  api: ApiClient;
  artifact: Artifact;
  close: () => void;
}) {
  const section = useRef<HTMLElement>(null);
  useEffect(() => {
    section.current?.focus();
  }, [artifact.id]);
  const [content, setContent] = useState<{ url: string; text?: string }>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    setContent(undefined);
    setError(undefined);
    void (async () => {
      try {
        const blob = await api.artifact(
          artifact.id,
          artifact.kind,
          artifact.sha256,
          controller.signal,
        );
        const text =
          artifact.kind !== 'SCREENSHOT'
            ? artifact.kind === 'TRACE'
              ? 'Chromium 时间线已校验，可下载 JSON 到 Perfetto / Chrome Trace Viewer 查看。'
              : JSON.stringify(JSON.parse(await blob.text()), null, 2)
            : undefined;
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setContent({ url: objectUrl, ...(text === undefined ? {} : { text }) });
      } catch (error) {
        if (!controller.signal.aborted) setError(errorMessage(error));
      }
    })();
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [api, artifact.id, artifact.kind, artifact.sha256]);
  return (
    <section
      ref={section}
      tabIndex={-1}
      className="panel evidence-view"
      aria-label="证据预览"
    >
      <div className="section-heading">
        <div>
          <h2>
            {artifact.kind === 'SCREENSHOT'
              ? '页面截图'
              : artifact.kind === 'NETWORK'
                ? '网络元数据'
                : artifact.kind === 'TRACE'
                  ? '浏览器执行 TRACE'
                  : 'DOM 观察'}
          </h2>
          <p className="mono muted wrap">{artifact.id}</p>
        </div>
        <button className="button button-secondary" onClick={close}>
          关闭预览
        </button>
      </div>
      <ErrorNotice message={error} />
      {!content && !error && <p role="status">正在读取并校验证据…</p>}
      {content && (
        <>
          {content.text !== undefined ? (
            <pre className="evidence-text">{content.text}</pre>
          ) : (
            <img
              className="evidence-image"
              src={content.url}
              alt={`验证证据 ${artifact.id}`}
            />
          )}
          <div className="form-footer">
            <span className="muted wrap">
              SHA-256 已核对 · {artifact.sha256}
            </span>
            <a
              className="button button-secondary"
              href={content.url}
              download={`${artifact.id}.${artifact.kind !== 'SCREENSHOT' ? 'json' : 'png'}`}
            >
              下载证据
            </a>
          </div>
        </>
      )}
    </section>
  );
}
