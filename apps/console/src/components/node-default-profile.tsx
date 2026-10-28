import { useEffect, useId, useRef, useState } from 'react';
import { LogIn } from 'lucide-react';
import { toast } from 'sonner';
import type { ConsoleNode } from './node-routing';
import { ApiClient, errorMessage } from '../api';
import { Modal } from './modal';
import { Button } from './ui/button';
import { DialogFooter } from './ui/dialog';
import { Input } from './ui/input';
import { ErrorNotice, time } from './ui';

/** 卡片只展示模板元数据；已保存不代表目标网站的登录仍然有效。 */
export function NodeDefaultProfile({ node }: { node: ConsoleNode }) {
  const supported = node.capabilities.nodeDefaultProfileVersion === 1;
  return (
    <section className="node-setting-row" aria-label="节点默认登录状态">
      <h3>默认登录状态</h3>
      <div className="node-setting-content">
        <p className="node-profile-state">
          <span>
            {node.default_profile
              ? '已保存'
              : supported
                ? '未初始化'
                : '未上报'}
          </span>
          <span className="muted">
            {node.default_profile
              ? `更新于 ${time(node.default_profile.updatedAt)}`
              : supported
                ? '新任务从空白会话开始'
                : '升级节点后可维护登录状态'}
          </span>
        </p>
        {node.default_profile && (
          <p className="node-profile-version mono muted wrap">
            版本 {node.default_profile.version}
          </p>
        )}
      </div>
    </section>
  );
}

/** 操作入口统一放在卡片管理区；先恢复已有会话，避免重复创建浏览器。 */
export function NodeProfileAction({
  api,
  node,
}: {
  api: ApiClient;
  node: ConsoleNode;
}) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const urlId = useId();
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  const run = async (create: boolean) => {
    if (active.current && !active.current.signal.aborted) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.json<{ id: string | null }>(
        `/v1/nodes/${encodeURIComponent(node.id)}/profile`,
        controller.signal,
        create ? { url } : undefined,
      );
      if (controller.signal.aborted) return;
      if (result.id)
        location.hash = `/node-profiles/${encodeURIComponent(result.id)}`;
      else setOpen(true);
    } catch (error) {
      if (!controller.signal.aborted) {
        if (create) setError(errorMessage(error));
        else toast.error(errorMessage(error));
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
      if (active.current === controller) active.current = null;
    }
  };
  const supported = node.capabilities.nodeDefaultProfileVersion === 1;
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={busy || !node.online || !!node.revoked_at || !supported}
        onClick={() => void run(false)}
      >
        <LogIn aria-hidden="true" />
        {busy && !open ? '正在查询…' : '维护登录状态'}
      </Button>
      {open && (
        <Modal
          title="维护登录状态"
          description={`为 ${node.name} 更新默认登录状态，供新任务复制使用。`}
          className="node-management-dialog"
          busy={busy}
          close={() => setOpen(false)}
        >
          <form
            className="node-dialog-form"
            onSubmit={(event) => {
              event.preventDefault();
              void run(true);
            }}
          >
            <div className="node-dialog-field">
              <label htmlFor={urlId}>首先打开的网址</label>
              <Input
                id={urlId}
                type="url"
                required
                disabled={busy}
                value={url}
                maxLength={2000}
                placeholder="https://example.com"
                aria-describedby={`${urlId}-hint`}
                onChange={(event) => setUrl(event.target.value)}
              />
              <p id={`${urlId}-hint`} className="muted note">
                进入远程浏览器后，可以继续访问并登录其他网站。
              </p>
            </div>
            <p className="node-dialog-note muted">
              完成登录后点击“保存并关闭”才会更新默认状态。正在运行的任务不受影响。
            </p>
            <ErrorNotice message={error} />
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setOpen(false)}
              >
                取消
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? '正在创建…' : '打开维护浏览器'}
              </Button>
            </DialogFooter>
          </form>
        </Modal>
      )}
    </>
  );
}
