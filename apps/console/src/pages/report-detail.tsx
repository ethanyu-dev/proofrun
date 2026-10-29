import { Button } from '../components/ui/button';
import { RequestMemberships } from '../components/request-memberships';
import {
  TaskExecutionStatus,
  ExecutionOutcomeDetails,
} from '../components/execution-outcome';
import { TaskIdentity } from '../components/task-identity';
import { useEffect, useState } from 'react';
import type { TaskDetail } from '@proofrun/contracts';
import { ApiClient } from '../api';
import { useResource } from '../use-resource';
import {
  Empty,
  ErrorNotice,
  PageHeader,
  RefreshBar,
  time,
} from '../components/ui';
import { ReportProgress } from '../components/report-status';
import { verificationProgress, reportDuration } from '../report-presentation';
import { VerificationSummary } from '../components/verification-summary';
import { ReportCriteria } from '../components/report-criteria';
import { ReportExport } from '../components/report-export';
import { TaskEvidence } from '../components/task-sections';
import { FollowUpCleanup } from '../components/follow-up-cleanup';
import { taskHref } from '../task-links';
import { executionModeLabel } from '../execution-mode';

/** 报告按单次任务身份读取；重新执行产生新任务，不覆盖此页的历史结论。 */
export function ReportDetailPage({ api, id }: { api: ApiClient; id: string }) {
  const resource = useResource<TaskDetail>(
    api,
    `/v1/tasks/${encodeURIComponent(id)}`,
  );
  const browser = resource.data?.definition.taskKind === 'browser';
  // 旧书签依据明确类型跳转；缺少标记的历史任务继续读取原验证报告。
  useEffect(() => {
    if (browser)
      window.location.replace(`#/browser-tasks/${encodeURIComponent(id)}`);
  }, [browser, id]);
  if (browser)
    return (
      <Empty title="正在打开浏览器任务…">
        <a href={`#/browser-tasks/${encodeURIComponent(id)}`}>查看任务详情</a>
      </Empty>
    );
  if (!resource.data)
    return (
      <>
        <ErrorNotice message={resource.error} />
        <Empty title={resource.loading ? '正在读取任务…' : '无法读取任务'} />
        {resource.error && (
          <Button variant="outline" onClick={resource.refresh}>
            重新读取任务
          </Button>
        )}
      </>
    );
  return (
    <div className="report-page">
      <PageHeader
        title="验证报告"
        description="核对本次结论、验收范围与原始证据。"
      >
        <Button asChild variant="outline">
          <a className="button button-secondary" href="#/tasks">
            返回任务
          </a>
        </Button>
        <Button asChild variant="outline">
          <a className="button button-secondary" href={taskHref('tasks', id)}>
            查看执行过程
          </a>
        </Button>
      </PageHeader>
      <RequestMemberships api={api} taskId={id} />
      <RefreshBar {...resource} />
      <ErrorNotice message={resource.error} />
      <ReportDetails api={api} task={resource.data} />
    </div>
  );
}

/** 报告、证据和导出始终绑定当前任务，不合并其他运行的验收结论。 */
export function ReportDetails({
  api,
  task,
}: {
  api: ApiClient;
  task: TaskDetail;
}) {
  const [exportOpen, setExportOpen] = useState(false);
  if (!task.report)
    return (
      <Empty title="尚未生成验证报告">
        当前执行状态：
        <TaskExecutionStatus task={task} />
      </Empty>
    );
  return (
    <div className="verification-report">
      <section className="panel report-overview" aria-label="报告结论">
        <div className="report-overview-main">
          <div>
            <p className="eyebrow">本次验证结论 · 通过 / 总数</p>
            <ReportProgress counts={verificationProgress(task)} />
            <h2>{task.definition.objective}</h2>
            <p className="muted wrap">{task.definition.target.url}</p>
          </div>
          <div className="report-overview-notes">
            <p className="muted">按验证项目统计，清理项目不计入总数。</p>
            <p className="muted">
              对：已证实符合预期；错：未证实符合预期，具体原因见验证记录；—：尚无记录。
            </p>
            <div className="report-mode-metrics">
              <div>
                <strong>LLM</strong>
                <span>执行时长：{reportDuration(task)}</span>
                <TaskExecutionStatus task={task} />
                <Button
                  variant="ghost"
                  className="text-button"
                  onClick={() => setExportOpen(!exportOpen)}
                >
                  导出报告
                </Button>
              </div>
            </div>
          </div>
        </div>
        <div className="report-context">
          <span>
            验证模式：{executionModeLabel(task.definition.executionMode)}
          </span>
          <span>环境：{task.definition.environment.id}</span>
          <span>验证结束：{time(task.finished_at)}</span>
        </div>
        {task.archived_at && (
          <p className="report-notice">
            原始证据已于 {time(task.archived_at)}{' '}
            清理。报告记录保留，证据不可预览或下载。
          </p>
        )}
      </section>
      <VerificationSummary task={task} />
      {exportOpen && (
        <ReportExport
          report={task.report}
          assessment={task}
          close={() => setExportOpen(false)}
        />
      )}
      <ReportSupportingDetails api={api} task={task} />
    </div>
  );
}

/** 展开证据只属于当前任务，身份和溯源信息放在结果之后。 */
function ReportSupportingDetails({
  api,
  task,
}: {
  api: ApiClient;
  task: TaskDetail;
}) {
  return (
    <>
      <ExecutionOutcomeDetails outcome={task.executionOutcome} />
      <ReportCriteria api={api} task={task} />
      <FollowUpCleanup api={api} task={task} />
      <TaskIdentity task={task} />
      <details className="panel report-support">
        <summary>
          全部证据{' '}
          <span className="muted">
            {task.report?.artifacts.length ?? 0} 份 ·{' '}
            {task.archived_at ? '已清理' : '可核对'}
          </span>
        </summary>
        <TaskEvidence api={api} task={task} />
      </details>
      <details className="panel report-support">
        <summary>报告溯源</summary>
        <dl className="facts">
          <div>
            <dt>关联任务</dt>
            <dd className="mono wrap">
              <a href={taskHref('tasks', task.id)}>{task.id}</a>
            </dd>
          </div>
          <div>
            <dt>模型</dt>
            <dd>{task.report?.executionDetails?.model ?? '未记录'}</dd>
          </div>
          <div>
            <dt>验证结束</dt>
            <dd>{time(task.finished_at)}</dd>
          </div>
        </dl>
      </details>
    </>
  );
}
