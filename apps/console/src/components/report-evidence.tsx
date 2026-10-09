import { useEffect, useRef, useState } from 'react';
import type { VerificationReport } from '@proofrun/contracts';
import { ApiClient } from '../api';
import { Evidence } from './evidence';

/** 证据按钮的媒介名必须准确，网络记录和 TRACE 不能误标为 DOM。 */
const KIND_LABELS = {
  SCREENSHOT: '页面截图',
  DOM: 'DOM 观察',
  NETWORK: '网络记录',
  TRACE: '执行时间线',
};
type Artifact = VerificationReport['artifacts'][number];

/** 缩略图仍通过认证接口和摘要校验读取；卸载或切换时释放图片地址。 */
export function ReportEvidenceButton({
  api,
  artifact,
  archived,
  onSelect,
}: {
  api: ApiClient;
  artifact: Artifact;
  archived: boolean;
  onSelect: () => void;
}) {
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (archived || artifact.kind !== 'SCREENSHOT') return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    setUrl(undefined);
    setFailed(false);
    void api
      .artifact(artifact.id, artifact.kind, artifact.sha256, controller.signal)
      .then((blob) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [api, artifact.id, artifact.kind, artifact.sha256, archived]);
  return (
    <button
      className="report-evidence-button"
      disabled={archived}
      onClick={(event) => {
        // 部分浏览器鼠标点击不聚焦按钮，显式记录模态框关闭后的返回位置。
        event.currentTarget.focus();
        onSelect();
      }}
    >
      {url && <img src={url} alt="关联页面截图缩略图" />}
      <span>
        {KIND_LABELS[artifact.kind]} <span aria-hidden="true">↗</span>
      </span>
      <small className="mono wrap">{artifact.id}</small>
      {archived && <small>证据已清理</small>}
      {failed && <small>缩略图读取失败，点击重试预览</small>}
    </button>
  );
}

/** 原生模态框提供焦点隔离、Escape 关闭与焦点归还；标题保留当前验收项归属。 */
export function ReportEvidenceDrawer({
  api,
  artifact,
  context,
  close,
}: {
  api: ApiClient;
  artifact: Artifact;
  context: string;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  // 在 React 卸载前关闭原生模态框，使浏览器仍能恢复到已记录的触发按钮。
  const dismiss = () => {
    dialog.current?.close();
    close();
  };
  return (
    <dialog
      ref={dialog}
      className="report-evidence-drawer"
      aria-label={`证据核对：${context}`}
      onCancel={(event) => {
        event.preventDefault();
        dismiss();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) dismiss();
      }}
    >
      <div className="report-evidence-content">
        <p className="eyebrow">证据核对</p>
        <h2>{context}</h2>
        <Evidence
          api={api}
          artifact={artifact}
          close={dismiss}
          focusOnMount={false}
        />
      </div>
    </dialog>
  );
}
