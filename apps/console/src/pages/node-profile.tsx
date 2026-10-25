import { Button } from '../components/ui/button';
import { useEffect, useState } from 'react';
import { ApiClient, errorMessage } from '../api';
import { ErrorNotice } from '../components/ui';
import {
  NodeProfileOutcome,
  type NodeProfileStatus,
} from '../components/node-profile-outcome';

/** 初始打开与关闭确认需要较快反馈，已进入交互后只低频读取终态。 */
const STARTUP_POLL_MS = 750;
const ACTIVE_POLL_MS = 3000;

/** 准入与初次导航完成后才挂载共用操作界面，启动期间也允许明确关闭。 */
export function NodeProfilePage({ api, id }: { api: ApiClient; id: string }) {
  const [status, setStatus] = useState<NodeProfileStatus>();
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
        setError(undefined);
        // 已进入交互后继续低频读取终态，节点异常关闭也能显示持久失败原因。
        if (!value.closed || value.failureDetailsPending)
          timer = setTimeout(
            () => void read(),
            value.ready || value.closed ? ACTIVE_POLL_MS : STARTUP_POLL_MS,
          );
      } catch (e) {
        if (!controller.signal.aborted) {
          setError(errorMessage(e));
          timer = setTimeout(() => void read(), ACTIVE_POLL_MS);
        }
      }
    };
    void read();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [api, id, attempt]);
  return (
    <section className="panel" aria-label="节点默认 profile">
      <p>节点模板维护已停用。此页面仅供查看历史状态和关闭遗留会话。</p>
      <NodeProfileOutcome status={status} closing={closing} />
      <ErrorNotice message={error} />
      <div className="page-actions">
        {(error || status?.failure) && (
          <Button
            variant="outline"
            className="button button-secondary"
            onClick={() => setAttempt((n) => n + 1)}
          >
            重新读取状态
          </Button>
        )}
        {!status?.closed && (
          <Button
            variant="outline"
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
            关闭遗留会话
          </Button>
        )}
        <Button asChild variant="outline">
          <a className="button button-secondary" href="#/nodes">
            返回节点管理
          </a>
        </Button>
      </div>
    </section>
  );
}
