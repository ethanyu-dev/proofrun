import { Modal } from './modal';
import { Button } from './ui/button';
import { useEffect, useState } from 'react';
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
    <Button
      variant="ghost"
      size="content"
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
    </Button>
  );
}

/** 证据抽屉复用组件库弹窗的焦点隔离与键盘关闭，标题保留验收项归属。 */
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
  return (
    <Modal
      title={`证据核对：${context}`}
      close={close}
      className="evidence-dialog"
    >
      <Evidence
        api={api}
        artifact={artifact}
        close={close}
        focusOnMount={false}
      />
    </Modal>
  );
}
