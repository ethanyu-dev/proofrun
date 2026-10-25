import type { ApiClient } from '../api';
import { useResource } from '../use-resource';
import { ErrorNotice } from './ui';
import { sourceRequestId } from '../task-links';

/** 共享执行可以出现在多个请求；从请求进入时保留显式返回入口。 */
export function RequestMemberships({
  api,
  taskId,
}: {
  api: ApiClient;
  taskId: string;
}) {
  const resource = useResource<{ requestId: string; title: string }[]>(
    api,
    `/v1/tasks/${encodeURIComponent(taskId)}/requests`,
    false,
  );
  const source = sourceRequestId();
  return (
    <section aria-label="请求归属">
      <ErrorNotice message={resource.error} />
      {resource.data &&
        (resource.data.length ? (
          <>
            <p>
              关联 {resource.data.length} 个请求
              {resource.data.length > 1
                ? '；取消此 case 会影响所有引用同一执行的请求。'
                : '。'}
            </p>
            <ul>
              {resource.data.map((r) => (
                <li key={r.requestId}>
                  <a href={`#/requests/${encodeURIComponent(r.requestId)}`}>
                    {source === r.requestId ? '返回来源请求：' : ''}
                    {r.title}
                  </a>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="muted">未归组任务</p>
        ))}
    </section>
  );
}
