import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { RequestResultV2 } from '@proofrun/contracts';
import { errorMessage, type ApiClient } from '../api';
import { Modal } from './modal';
import { ErrorNotice } from './ui';
import { Button } from './ui/button';

/** 请求级删除统一交给服务端事务处理，避免逐个删除 case 留下部分结果。 */
export function RequestDelete({
  api,
  value,
}: {
  api: ApiClient;
  value: RequestResultV2;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const active = useRef<AbortController | null>(null);
  const finished = value.executionStatus === 'FINISHED';
  useEffect(() => () => active.current?.abort(), []);

  /** 同一请求删除幂等；响应未确认时保留页面和错误，由用户决定重试。 */
  const remove = async () => {
    if (active.current || !finished) return;
    const controller = new AbortController();
    active.current = controller;
    setPending(true);
    setError(undefined);
    try {
      await api.json(
        `/v2/requests/${encodeURIComponent(value.requestId)}/delete`,
        controller.signal,
        {},
      );
      if (!controller.signal.aborted) {
        setOpen(false);
        toast.success('记录已删除');
        location.hash = '/tasks';
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
        title={
          finished
            ? '删除该请求及关联 case 执行记录，并从统计中排除'
            : '请等待全部 case 执行结束后删除'
        }
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
          description={`删除“${value.title}”及其关联的 ${value.caseCount} 个 case 执行记录？删除后将从任务列表及统计中移除。`}
          busy={pending}
          close={() => setOpen(false)}
        >
          <p>仍被其他请求引用的执行记录将保留。</p>
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
