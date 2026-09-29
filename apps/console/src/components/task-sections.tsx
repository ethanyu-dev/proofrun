import { useState } from 'react';
import type { TaskDetail } from '@proofrun/contracts';
import { ApiClient } from '../api';
import { Evidence } from './evidence';
import { ReportExport } from './report-export';
import { ReportSummary } from './report-summary';
import { Status, time } from './ui';

/** 单组结果组件始终接收完整任务，执行、报告和证据不能跨组共享身份。 */
type TaskSectionProps = { api: ApiClient; task: TaskDetail };

/** 任务终态与会话关闭确认分别展示，组内时间不借用入口任务的数据。 */
export function TaskResources({ task }: { task: TaskDetail }) {
  return (
    <>
      {' '}
      <section className="panel">
        <div className="section-heading">
          <h2>执行与资源清理</h2>
        </div>
        <dl className="facts">
          <div>
            <dt>任务状态</dt>
            <dd>
              <Status value={task.state} />
            </dd>
          </div>
          <div>
            <dt>创建时间</dt>
            <dd>{time(task.created_at)}</dd>
          </div>
          <div>
            <dt>截止时间</dt>
            <dd>{time(task.deadline_at)}</dd>
          </div>
          <div>
            <dt>结束时间</dt>
            <dd>{time(task.finished_at)}</dd>
          </div>
        </dl>
        {task.businessCleanup && (
          <p>
            业务清理：
            <Status value={task.businessCleanup.status} />{' '}
            {task.businessCleanup.status !== 'PENDING' &&
            task.businessCleanup.status !== 'SKIPPED' ? (
              <a
                href={`#/tasks/${encodeURIComponent(task.businessCleanup.taskId)}`}
              >
                查看清理任务
              </a>
            ) : (
              <span className="muted">
                {task.businessCleanup.status === 'PENDING'
                  ? '等待主任务结束并确认会话关闭'
                  : '主任务未开始，无需清理'}
              </span>
            )}
          </p>
        )}
        {task.definition.parentTaskId && (
          <p>
            关联主任务：
            <a
              href={`#/tasks/${encodeURIComponent(task.definition.parentTaskId)}`}
            >
              {task.definition.parentTaskId}
            </a>
          </p>
        )}
        {task.error && (
          <pre className="error-notice">
            {JSON.stringify(task.error, null, 2)}
          </pre>
        )}
        {task.executions.length === 0 ? (
          <p className="muted">尚未分配浏览器会话。</p>
        ) : (
          task.executions.map((execution) => (
            <div className="execution-summary" key={execution.id}>
              <dl className="facts">
                <div>
                  <dt>节点</dt>
                  <dd className="mono wrap">{execution.node_id}</dd>
                </div>
                <div>
                  <dt>执行进度</dt>
                  <dd>
                    <Status value={execution.state} />
                  </dd>
                </div>
                <div>
                  <dt>会话状态</dt>
                  <dd>
                    <Status value={execution.session_state} />
                  </dd>
                </div>
                <div>
                  <dt>资源清理</dt>
                  <dd>
                    {execution.closure_verified
                      ? '已确认关闭'
                      : '尚未确认关闭，容量继续保留'}
                  </dd>
                </div>
                <div>
                  <dt>已提交动作</dt>
                  <dd>{execution.action_count}</dd>
                </div>
                <div>
                  <dt>会话 ID</dt>
                  <dd className="mono wrap">{execution.session_id}</dd>
                </div>
              </dl>
            </div>
          ))
        )}
      </section>
    </>
  );
}

/** 报告导出与引用预览仅使用当前组报告，两个组可分别打开和关闭。 */
export function TaskReport({ api, task }: TaskSectionProps) {
  const report = task.report;
  const [artifactId, setArtifactId] = useState<string>();
  const [exportOpen, setExportOpen] = useState(false);
  const selected = report?.artifacts.find((item) => item.id === artifactId);
  return (
    <>
      {exportOpen && report && (
        <ReportExport report={report} close={() => setExportOpen(false)} />
      )}
      <section className="panel" aria-label="验收报告">
        <div className="section-heading">
          <h2>验收报告</h2>
          {report && (
            <div className="status-group">
              <button
                className="button button-secondary button-small"
                onClick={() => setExportOpen(true)}
              >
                导出此组报告
              </button>
              <Status value={report.executionDisposition} />
              <Status value={report.verdict} />
            </div>
          )}
        </div>
        {task.archived_at && (
          <p className="error-notice">
            证据内容已于 {time(task.archived_at)}{' '}
            按保留策略清理。报告结论仍可查阅，原始证据已不可下载。
          </p>
        )}
        {report ? (
          <ReportSummary text={report.summary} />
        ) : (
          <p className="muted">
            尚未生成报告。任务状态本身不代表产品验收结论。
          </p>
        )}
        {task.definition.steps && (
          <div className="criteria-list" aria-label="步骤执行结果">
            {task.definition.steps.map((step) => {
              const result = (report?.steps ?? task.stepResults)?.find(
                (s) => s.stepId === step.stepId,
              );
              return (
                <article className="criterion" key={step.stepId}>
                  <div className="section-heading">
                    <h3>
                      {step.exec_order}. {step.description}
                    </h3>
                    <Status value={result?.status ?? 'PENDING'} />
                  </div>
                  <p className="muted">
                    {step.type === 'setup' ? '前置操作' : '业务验收'} ·{' '}
                    {step.stepId}
                  </p>
                  <p className="wrap">入口：{step.url}</p>
                  {step.policy.length > 0 && (
                    <p>操作约束：{step.policy.join('；')}</p>
                  )}
                  {step.wait && (
                    <p>等待时长：{step.wait.durationMs / 1000} 秒</p>
                  )}
                  {result && <ReportSummary text={result.summary} />}
                  {!!result?.evidenceRefs.length && (
                    <div className="evidence-links">
                      {result.evidenceRefs.map((ref) => (
                        <button
                          key={ref}
                          className="button button-secondary button-small"
                          disabled={
                            !report?.artifacts.some((a) => a.id === ref)
                          }
                          onClick={() => setArtifactId(ref)}
                        >
                          步骤证据 {ref.slice(0, 8)}
                        </button>
                      ))}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
        <div className="criteria-list">
          {task.definition.acceptanceCriteria.map((criterion) => {
            const result = report?.criteria.find(
              (item) => item.criterionId === criterion.id,
            );
            return (
              <article className="criterion" key={criterion.id}>
                <div className="section-heading">
                  <div>
                    <span className="mono muted">{criterion.id}</span>
                    <h3>{criterion.description}</h3>
                  </div>
                  <Status value={result?.verdict} />
                </div>
                <p>
                  <span className="muted">预期结果：</span>
                  {criterion.expectedResult}
                </p>
                <p className="muted">
                  要求证据：{criterion.evidenceKinds.join(' / ')}
                </p>
                {result && <ReportSummary text={result.summary} />}
                {!!result?.evidenceRefs.length && (
                  <div className="evidence-links">
                    {result.evidenceRefs.map((ref) => (
                      <button
                        className="button button-secondary button-small"
                        key={ref}
                        onClick={() => setArtifactId(ref)}
                      >
                        {report?.artifacts.find((item) => item.id === ref)
                          ?.kind === 'SCREENSHOT'
                          ? '查看截图'
                          : '查看 DOM'}{' '}
                        <span className="mono">{ref.slice(0, 8)}</span>
                      </button>
                    ))}
                  </div>
                )}
              </article>
            );
          })}
        </div>
        {report?.executionDetails && (
          <dl className="facts report-metrics">
            <div>
              <dt>模型</dt>
              <dd>{report.executionDetails.model}</dd>
            </div>
            <div>
              <dt>模型调用 / 动作</dt>
              <dd>
                {report.executionDetails.modelCalls} /{' '}
                {report.executionDetails.actions}
              </dd>
            </div>
            <div>
              <dt>执行耗时</dt>
              <dd>
                {(report.executionDetails.elapsedMs / 1000).toFixed(1)} 秒
              </dd>
            </div>
            <div>
              <dt>已记录输入 / 输出 token</dt>
              <dd>
                {report.executionDetails.promptTokens} /{' '}
                {report.executionDetails.completionTokens}
              </dd>
            </div>
          </dl>
        )}
      </section>
      {selected && (
        <Evidence
          key={selected.id}
          api={api}
          artifact={selected}
          close={() => setArtifactId(undefined)}
        />
      )}
    </>
  );
}

/** 全部证据按任务归属列出；尚未出报告时明确显示等待状态。 */
export function TaskEvidence({ api, task }: TaskSectionProps) {
  const report = task.report;
  const [artifactId, setArtifactId] = useState<string>();
  const selected = report?.artifacts.find((item) => item.id === artifactId);
  return (
    <>
      {!report?.artifacts.length && (
        <section className="panel">
          <h2>全部证据</h2>
          <p className="muted">
            {report
              ? '本组报告未附带证据。'
              : '尚未生成报告，证据清单将在报告就绪后显示。'}
          </p>
        </section>
      )}
      {!!report?.artifacts.length && (
        <section className="panel">
          <div className="section-heading">
            <h2>全部证据</h2>
            <span className="muted">{report.artifacts.length} 项</span>
          </div>
          <div className="artifact-list">
            {report.artifacts.map((artifact) => (
              <button
                className="artifact-button"
                key={artifact.id}
                aria-pressed={artifactId === artifact.id}
                onClick={() => setArtifactId(artifact.id)}
              >
                <span>{artifact.kind}</span>
                <span className="mono wrap">{artifact.id}</span>
                <span aria-hidden="true">↗</span>
              </button>
            ))}
          </div>
        </section>
      )}
      {selected && (
        <Evidence
          key={selected.id}
          api={api}
          artifact={selected}
          close={() => setArtifactId(undefined)}
        />
      )}
    </>
  );
}

/** 保留两组各自的执行定义，便于核对组身份与共同验收条件。 */
export function TaskDefinition({ task }: { task: TaskDetail }) {
  return (
    <details className="panel">
      <summary>原始任务定义</summary>
      <pre className="evidence-text">
        {JSON.stringify(task.definition, null, 2)}
      </pre>
    </details>
  );
}
