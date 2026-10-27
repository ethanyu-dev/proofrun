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
import {
  verificationProgress,
  reportMode,
  reportDuration,
} from '../report-presentation';
import { VerificationSummary } from '../components/verification-summary';
import { ReportCriteria } from '../components/report-criteria';
import { ReportExport } from '../components/report-export';
import { TaskEvidence } from '../components/task-sections';
import { FollowUpCleanup } from '../components/follow-up-cleanup';
import { taskHref } from '../task-links';
import {
  executionModeLabel,
  HISTORICAL_EXECUTION_NOTICE,
} from '../execution-mode';

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
      {resource.data.definition.comparison ? (
        <PairedReportDetails key={id} api={api} task={resource.data} />
      ) : (
        <ReportDetails api={api} task={resource.data} />
      )}
    </div>
  );
}

/** 通过服务端关联读取双组，不从任务名字或相邻列表行猜测另一组。 */
function PairedReportDetails({
  api,
  task,
}: {
  api: ApiClient;
  task: TaskDetail;
}) {
  const resource = useResource<{ comparison: null | { arms: TaskDetail[] } }>(
    api,
    `/v1/tasks/${encodeURIComponent(task.id)}/comparison`,
  );
  const arms = resource.data?.comparison?.arms;
  return (
    <>
      <ErrorNotice message={resource.error} />
      {!arms?.length && (
        <p className="report-notice">
          {resource.loading
            ? '正在读取两种模式的验证记录…'
            : '双跑记录暂不可用，当前计数仅包含已读取项目。'}
        </p>
      )}
      <ReportDetails api={api} task={task} arms={arms} />
    </>
  );
}

/** 顶部展示覆盖与各模式耗时，逐项原文、证据及导出仍绑定各自任务身份。 */
export function ReportDetails({
  api,
  task,
  arms,
}: {
  api: ApiClient;
  task: TaskDetail;
  arms?: TaskDetail[] | undefined;
}) {
  const [exportId, setExportId] = useState<string>();
  const tasks = (arms?.length ? arms : [task])
    .slice()
    .sort(
      (a, b) =>
        Number(reportMode(a) === 'jev') - Number(reportMode(b) === 'jev'),
    );
  const paired = !!task.definition.comparison;
  const exported = tasks.find((item) => item.id === exportId);
  if (!tasks.some((item) => item.report))
    return (
      <Empty title="尚未生成验证报告">
        当前执行状态：
        <TaskExecutionStatus task={task} />
      </Empty>
    );
  return (
    <div className="verification-report">
      <section className="panel report-overview" aria-label="报告结论">
        {(paired || reportMode(task) === 'jev') && (
          <p className="muted">{HISTORICAL_EXECUTION_NOTICE}</p>
        )}
        <div className="report-overview-main">
          <div>
            <p className="eyebrow">本次验证结论 · 通过 / 总数</p>
            <ReportProgress counts={verificationProgress(tasks)} />
            <h2>{task.definition.objective}</h2>
            <p className="muted wrap">{task.definition.target.url}</p>
          </div>
          <div className="report-overview-notes">
            <p className="muted">
              {paired
                ? '同一验证项目任一模式为对，即计入通过数；两种模式不重复计数。'
                : '按验证项目统计，清理项目不计入总数。'}
            </p>
            <p className="muted">
              对：已证实符合预期；错：未证实符合预期，具体原因见各模式记录；—：尚无记录。
            </p>
            <div className="report-mode-metrics">
              {(paired ? (['llm', 'jev'] as const) : [reportMode(task)]).map(
                (mode) => {
                  const arm = tasks.find((item) => reportMode(item) === mode);
                  return (
                    <div key={mode}>
                      <strong>
                        {mode === 'llm' ? 'LLM' : 'LLM + JEV（历史）'}
                      </strong>
                      <span>
                        执行时长：{arm ? reportDuration(arm) : '待获取'}
                      </span>
                      {arm && <TaskExecutionStatus task={arm} />}
                      {arm?.report && (
                        <Button
                          variant="ghost"
                          className="text-button"
                          onClick={() =>
                            setExportId(
                              exportId === arm.id ? undefined : arm.id,
                            )
                          }
                        >
                          导出{paired ? '本组' : ''}报告
                        </Button>
                      )}
                    </div>
                  );
                },
              )}
            </div>
          </div>
        </div>
        <div className="report-context">
          <span>
            验证模式：
            {paired
              ? '历史对照：LLM / LLM + JEV（已停用）'
              : executionModeLabel(task.definition.executionMode)}
          </span>
          <span>环境：{task.definition.environment.id}</span>
          {!paired && <span>验证结束：{time(task.finished_at)}</span>}
        </div>
        {tasks
          .filter((item) => item.archived_at)
          .map((item) => (
            <p key={item.id} className="report-notice">
              {paired
                ? `${reportMode(item) === 'llm' ? 'LLM' : 'LLM + JEV'}：`
                : ''}
              原始证据已于 {time(item.archived_at)}{' '}
              清理。报告记录保留，证据不可预览或下载。
            </p>
          ))}
      </section>
      <VerificationSummary task={task} tasks={tasks} />
      {exported?.report && (
        <ReportExport
          report={exported.report}
          assessment={exported}
          close={() => setExportId(undefined)}
        />
      )}
      {paired ? (
        <section className="report-mode-details" aria-label="各模式验证记录">
          {tasks.map((item) => (
            <details key={item.id} className="panel report-support">
              <summary>
                {reportMode(item) === 'llm' ? 'LLM' : 'LLM + JEV（历史）'} ·
                验证记录与证据{' '}
                <ReportProgress counts={verificationProgress([item])} />
              </summary>
              <ReportSupportingDetails api={api} task={item} />
            </details>
          ))}
        </section>
      ) : (
        <ReportSupportingDetails api={api} task={task} />
      )}
    </div>
  );
}

/** 身份和溯源下移，展开的证据只属于当前模式，避免双跑证据混用。 */
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
