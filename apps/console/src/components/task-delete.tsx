import { useEffect, useRef, useState } from 'react';
import { errorMessage, type ApiClient } from '../api';
import { ErrorNotice } from './ui';

/** 单条与批量共用原子删除接口；确认后冻结选择，失败时保留错误和原列表。 */
export function TaskDelete({
  api,
  ids,
  requests = false,
  onDeleted,
  disabled = false,
}: {
  api: ApiClient;
  ids: string[];
  requests?: boolean;
  onDeleted: () => void;
  disabled?: boolean;
}) {
  const [selection, setSelection] = useState<string[] | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  async function remove() {
    if (!selection || active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setPending(true);
    setError(undefined);
    try {
      await api.json(
        requests ? '/v2/requests/delete' : '/v1/tasks/delete',
        controller.signal,
        { ids: selection },
      );
      if (!controller.signal.aborted) {
        setSelection(null);
        onDeleted();
      }
    } catch (error) {
      if (!controller.signal.aborted) setError(errorMessage(error));
    } finally {
      active.current = null;
      if (!controller.signal.aborted) setPending(false);
    }
  }
  return (
    <div className="task-delete">
      <button
        className="button button-secondary button-small"
        disabled={disabled || !ids.length || pending}
        onClick={() => {
          setError(undefined);
          setSelection([...ids]);
        }}
      >
        {ids.length > 1 ? `删除选中（${ids.length}）` : '删除'}
      </button>
      {selection && (
        <div className="confirm-panel" role="alert">
          <p>
            确认删除 {selection.length} 条{requests ? '请求' : '运行'}
            记录？删除后从列表和统计中排除，双跑及清理一起处理。
            {requests && '其他请求仍引用的共享运行会保留。'}
          </p>
          <button
            className="button button-secondary"
            disabled={pending}
            onClick={() => void remove()}
          >
            {pending ? '删除中…' : '确认删除'}
          </button>{' '}
          <button
            className="button button-secondary"
            disabled={pending}
            onClick={() => setSelection(null)}
          >
            取消
          </button>
        </div>
      )}
      <ErrorNotice message={error} />
    </div>
  );
}
