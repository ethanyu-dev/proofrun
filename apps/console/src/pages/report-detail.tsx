import { useState } from 'react';
import type { TaskDetail } from '@proofrun/contracts';
import { ApiClient } from '../api';
import { useResource } from '../use-resource';
import {
  Empty,
  ErrorNotice,
  PageHeader,
  RefreshBar,
  Status,
  time,
} from '../components/ui';
import { ReportCounts, ReportStatus } from '../components/report-status';
import { ReportCriteria } from '../components/report-criteria';
import { ReportSummary } from '../components/report-summary';
import { ReportExport } from '../components/report-export';
import { TaskEvidence } from '../components/task-sections';

/** 报告按单次任务身份读取；重新执行产生新任务，不覆盖此页的历史结论。 */
export function ReportDetailPage({ api, id }: { api: ApiClient; id: string }) {
  const resource = useResource<TaskDetail>(
    api,
    `/v1/tasks/${encodeURIComponent(id)}`,
  );
  return (
    <>
      <PageHeader
        title="验证报告"
        description="核对本次结论、验收范围与原始证据。"
      >
        <a className="button button-secondary" href="#/reports">
          返回报告
        </a>
        <a
          className="button button-secondary"
          href={`#/tasks/${encodeURIComponent(id)}`}
        >
          查看任务详情
        </a>
      </PageHeader>
      <RefreshBar {...resource} />
      <ErrorNotice message={resource.error} />
      {resource.data ? (
        <ReportDetails api={api} task={resource.data} />
      ) : (
        <Empty title={resource.loading ? '正在读取报告…' : '无法读取报告'}>
          {resource.loading
            ? undefined
            : '请检查任务身份、访问凭据和服务连接。'}
        </Empty>
      )}
    </>
  );
}

/** 展示只消费服务端状态，执行异常说明和未覆盖范围与验收结论并列保留。 */
export function ReportDetails({
  api,
  task,
}: {
  api: ApiClient;
  task: TaskDetail;
}) {
  const [exportOpen, setExportOpen] = useState(false);
  const report = task.report;
  if (!report)
    return (
      <Empty title="尚未生成验证报告">
        当前执行状态：
        <Status value={task.state} />
        。执行终态本身不产生验收结论。
      </Empty>
    );
  const unresolved =
    (task.criteriaCounts?.inconclusive ?? 0) +
    (task.criteriaCounts?.skipped ?? 0);
  return (
    <div className="verification-report">
      <section className="panel report-overview" aria-label="报告结论">
        <div className="section-heading">
          <div>
            <p className="eyebrow">本次验证结论</p>
            <ReportStatus value={task.reportStatus} />
          </div>
          <button
            className="button button-primary"
            onClick={() => setExportOpen(!exportOpen)}
          >
            导出报告
          </button>
        </div>
        <h2>{task.definition.objective}</h2>
        <p className="muted wrap">{task.definition.target.url}</p>
        <div className="report-context">
          <span>环境：{task.definition.environment.id}</span>
          <span>验证结束：{time(task.finished_at)}</span>
          <span>
            执行状态：
            <Status value={task.state} />{' '}
            <Status value={report.executionDisposition} />
          </span>
        </div>
        <ReportCounts counts={task.criteriaCounts} />
        <ReportSummary text={report.summary} />
        {unresolved > 0 && (
          <p className="report-notice">
            {unresolved} 项尚未得出结论，本报告不能证明这些验收要求已满足。
          </p>
        )}
        {report.executionDisposition !== 'EXECUTED' && (
          <p className="report-notice">
            本次执行
            {report.executionDisposition === 'BLOCKED' ? '受阻' : '异常终止'}
            。执行异常本身不表示产品缺陷，已完成的逐项结论保留如下。
          </p>
        )}
        {task.archived_at && (
          <p className="report-notice">
            原始证据已于 {time(task.archived_at)}{' '}
            清理。报告结论保留，证据不可预览或下载。
          </p>
        )}
      </section>
      {exportOpen && (
        <ReportExport
          report={report}
          assessment={task}
          close={() => setExportOpen(false)}
        />
      )}
      <ReportCriteria api={api} task={task} />
      <details className="panel report-support">
        <summary>
          执行过程{' '}
          <span className="muted">
            {report.steps?.length ?? 0} 个结构化步骤
          </span>
        </summary>
        {report.steps?.length ? (
          report.steps.map((step) => (
            <article className="report-step" key={step.stepId}>
              <div className="section-heading">
                <h3>
                  {task.definition.steps?.find(
                    (item) => item.stepId === step.stepId,
                  )?.description ?? step.stepId}
                </h3>
                <Status value={step.status} />
              </div>
              <p className="muted">
                {step.stepId} · {time(step.startedAt)} → {time(step.finishedAt)}
              </p>
              <ReportSummary text={step.summary} />
            </article>
          ))
        ) : (
          <p className="muted">
            本次没有结构化步骤记录，动作与模型调用记录可在任务详情查看。
          </p>
        )}
      </details>
      <details className="panel report-support">
        <summary>
          全部证据{' '}
          <span className="muted">
            {report.artifacts.length} 份 ·{' '}
            {task.archived_at
              ? '已清理'
              : report.artifacts.length
                ? '可核对'
                : '未附证据'}
          </span>
        </summary>
        <TaskEvidence api={api} task={task} />
      </details>
      <section className="panel" aria-label="报告溯源">
        <h2>报告溯源</h2>
        <dl className="facts">
          <div>
            <dt>关联任务</dt>
            <dd className="mono wrap">
              <a href={`#/tasks/${encodeURIComponent(task.id)}`}>{task.id}</a>
            </dd>
          </div>
          <div>
            <dt>执行模式</dt>
            <dd>
              {task.definition.executionMode === 'jev' ? 'LLM + JEV' : '纯 LLM'}
            </dd>
          </div>
          <div>
            <dt>模型</dt>
            <dd>{report.executionDetails?.model ?? '未记录'}</dd>
          </div>
          <div>
            <dt>执行耗时</dt>
            <dd>
              {report.executionDetails
                ? `${(report.executionDetails.elapsedMs / 1000).toFixed(1)} 秒`
                : '未记录'}
            </dd>
          </div>
        </dl>
        <p className="muted">
          报告对应本次执行；重新运行的结果保存在新的任务中。
        </p>
      </section>
    </div>
  );
}
