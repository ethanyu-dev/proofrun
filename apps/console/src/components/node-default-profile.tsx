import { useEffect, useRef, useState } from 'react';
import type { ConsoleNode } from './node-routing';
import { ApiClient, errorMessage } from '../api';
import { Modal } from './modal';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { ErrorNotice, time } from './ui';

/** 每次先查询已有维护会话，重复点击或刷新不会新建第二个浏览器。 */
export function NodeDefaultProfile({
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
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  const navigate = (id: string) => {
    location.hash = `/node-profiles/${encodeURIComponent(id)}`;
  };
  const run = async (create: boolean) => {
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.json<{ id: string | null }>(
        `/v1/nodes/${node.id}/profile`,
        controller.signal,
        create ? { url } : undefined,
      );
      if (controller.signal.aborted) return;
      if (result.id) navigate(result.id);
      else setOpen(true);
    } catch (error) {
      if (!controller.signal.aborted) setError(errorMessage(error));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  const supported = node.capabilities.nodeDefaultProfileVersion === 1;
  return (
    <section aria-label="节点默认登录状态">
      <h3>默认登录状态</h3>
      <p>
        {node.default_profile
          ? `已保存 · ${time(node.default_profile.updatedAt)}`
          : supported
            ? '未初始化 · 新任务从空白会话开始'
            : '节点未上报模板状态'}
      </p>
      {node.default_profile && (
        <p className="muted wrap">版本 {node.default_profile.version}</p>
      )}
      <Button
        variant="outline"
        disabled={busy || !node.online || !!node.revoked_at || !supported}
        onClick={() => void run(false)}
      >
        维护登录状态
      </Button>
      {!supported && <p className="muted">升级节点后可维护默认登录状态。</p>}
      <ErrorNotice message={error} />
      {open && (
        <Modal
          title="维护节点登录状态"
          busy={busy}
          close={() => setOpen(false)}
        >
          <p>
            打开网站后，可在远程浏览器中依次登录多个网站。保存后供该节点的新任务复制使用。
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void run(true);
            }}
          >
            <label htmlFor="profile-url">首先打开的网址</label>
            <Input
              id="profile-url"
              type="url"
              required
              value={url}
              maxLength={2000}
              placeholder="https://example.com"
              onChange={(event) => setUrl(event.target.value)}
            />
            <ErrorNotice message={error} />
            <div className="page-actions">
              <Button type="submit" disabled={busy}>
                {busy ? '正在创建…' : '打开维护浏览器'}
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
