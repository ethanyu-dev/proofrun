import type { ApiClient } from '../api';
import { useResource } from '../use-resource';
import { ErrorNotice, Status, time } from './ui';

/** 每条历史链接固定运行身份；新运行出现后旧报告入口仍指向原记录。 */
export function CaseRunHistory({
  api,
  caseId,
  taskId,
}: {
  api: ApiClient;
  caseId: string;
  taskId?: string;
}) {
  const resource = useResource<{
    runs: {
      /** 服务端返回的不可变运行身份。 */
      runId: string;
      /** 主组详情与报告的固定路由身份。 */
      taskId: string;
      /** 生命周期用于展示执行状态，不表示验收通过。 */
      state: string;
      /** 本次运行的提交时间，用于区分历次执行。 */
      createdAt: string;
      /** 尚未结束时为空。 */
      finishedAt: string | null;
    }[];
  }>(api, `/v2/cases/${encodeURIComponent(caseId)}/runs`);
  return (
    <details className="panel case-run-history">
      <summary>
        历史运行 · {caseId}
        {resource.data ? `（${resource.data.runs.length} 次）` : ''}
      </summary>
      <ErrorNotice message={resource.error} />
      {resource.loading && !resource.data && <p>正在读取历史运行…</p>}
      <ul>
        {resource.data?.runs.map((run, index) => (
          <li key={run.runId}>
            <a href={`#/tasks/${encodeURIComponent(run.taskId)}`}>
              {index === 0 ? '最新运行' : '历史运行'} · {time(run.createdAt)}
            </a>{' '}
            <Status value={run.state} />{' '}
            {run.taskId === taskId && <span>当前查看</span>}{' '}
            <a href={`#/reports/${encodeURIComponent(run.taskId)}`}>查看报告</a>
          </li>
        ))}
      </ul>
    </details>
  );
}
