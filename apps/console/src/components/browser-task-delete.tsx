import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { TaskList } from '@proofrun/contracts';
import { errorMessage, type ApiClient } from '../api';
import { Modal } from './modal';
import { ErrorNotice } from './ui';
import { Button } from './ui/button';

/** 列表与详情共用删除入口；会话关闭等最终约束由服务端事务校验。 */
export function BrowserTaskDelete({
  api,
  task,
  onDeleted,
}: {
  api: ApiClient;
  /** 只依赖列表也能提供的任务身份、目标与生命周期。 */
  task: Pick<TaskList['tasks'][number], 'id' | 'objective' | 'state'>;
  /** 成功后由所在页面刷新列表或返回列表，失败时保留原页面。 */
  onDeleted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const active = useRef<AbortController | null>(null);
  const finished = task.state !== 'QUEUED' && task.state !== 'RUNNING';
  useEffect(() => () => active.current?.abort(), []);

  /** 删除接口幂等；未确认成功前不导航，并阻止重复点击发出并发请求。 */
  const remove = async () => {
    if (active.current || !finished) return;
    const controller = new AbortController();
    active.current = controller;
    setPending(true);
    setError(undefined);
    try {
      await api.json(
        `/v1/tasks/${encodeURIComponent(task.id)}/delete`,
        controller.signal,
        {},
      );
      if (!controller.signal.aborted) {
        setOpen(false);
        toast.success('记录已删除');
        onDeleted();
      }
    } catch (failure) {
      if (!controller.signal.aborted) setError(errorMessage(failure));
    } finally {
      active.current = null;
      if (!controller.signal.aborted) setPending(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        variant="link"
        size="content"
        className="request-delete-trigger"
        disabled={!finished || pending}
        title={finished ? '删除该浏览器任务记录' : '请等待任务结束后删除'}
        onClick={() => {
          setError(undefined);
          setOpen(true);
        }}
      >
        删除记录
      </Button>
      {open && (
        <Modal
          title="删除记录"
          description={`删除“${task.objective}”？删除后将从浏览器任务列表中移除，任务详情将不可访问。`}
          busy={pending}
          close={() => setOpen(false)}
        >
          <ErrorNotice message={error} />
          <div className="page-actions">
            <Button
              type="button"
              variant="outline"
              data-dialog-cancel
              disabled={pending}
              onClick={() => setOpen(false)}
            >
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={pending || !finished}
              onClick={() => void remove()}
            >
              {pending ? '正在删除…' : '确认删除'}
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
