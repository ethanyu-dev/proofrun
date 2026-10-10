import { useEffect, useRef, useState } from 'react';
import type { TaskDetail } from '@proofrun/contracts';
import { ApiClient, errorMessage } from '../api';
import { useResource } from '../use-resource';
import { ExecutionControl } from '../components/execution-control';
import { TaskRerun } from '../components/task-rerun';
import { Comparison } from '../components/comparison';
import {
  TaskResources,
  TaskReport,
  TaskEvidence,
  TaskDefinition,
} from '../components/task-sections';
import { DecisionContext } from '../components/decision-context';
import {
  Empty,
  ErrorNotice,
  PageHeader,
  RefreshBar,
  Status,
} from '../components/ui';

/** 任务结果与资源清理并列显示；取消的成功响应不能冒充节点已释放。 */
export function TaskDetailPage({ api, id }: { api: ApiClient; id: string }) {
  const resource = useResource<TaskDetail>(
    api,
    `/v1/tasks/${encodeURIComponent(id)}`,
  );
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const active = useRef<AbortController | null>(null);
  const comparisonId = useRef(`compare-${crypto.randomUUID()}`);
  useEffect(() => () => active.current?.abort(), []);
  const cancel = async () => {
    if (pending) return;
    const controller = new AbortController();
    active.current = controller;
    setPending(true);
    setError(undefined);
    try {
      await api.json(
        `/v1/tasks/${encodeURIComponent(id)}/cancel`,
        controller.signal,
        {},
      );
      if (!controller.signal.aborted) {
        setConfirmCancel(false);
        resource.refresh();
      }
    } catch (error) {
      if (!controller.signal.aborted) setError(errorMessage(error));
    } finally {
      if (!controller.signal.aborted) setPending(false);
    }
  };
  const task = resource.data;
  const paired = !!task?.definition.comparison;
  return (
    <>
      <PageHeader
        title={paired ? '对照任务详情' : '任务详情'}
        description={task?.definition.comparison?.id ?? id}
      >
        <a className="button button-secondary" href="#/tasks">
          返回任务
        </a>
        {task?.report && (
          <a
            className="button button-primary"
            href={`#/reports/${encodeURIComponent(id)}`}
          >
            查看验证报告
          </a>
        )}
        {task &&
          (!task.definition.steps || task.definition.caseV2Definition) && (
            <TaskRerun
              key={id}
              api={api}
              id={id}
              paired={!!task.definition.comparison}
              caseId={task.definition.caseV2Definition?.caseId}
            />
          )}
        {task && !paired && !task.definition.steps && (
          <button
            className="button button-primary"
            disabled={pending}
            onClick={async () => {
              if (pending) return;
              setPending(true);
              setError(undefined);
              const controller = new AbortController();
              active.current = controller;
              try {
                const result = await api.json<{ taskId: string }>(
                  `/v1/tasks/${id}/compare`,
                  controller.signal,
                  { comparisonId: comparisonId.current },
                );
                if (!controller.signal.aborted)
                  location.hash = `/tasks/${result.taskId}`;
              } catch (error) {
                if (!controller.signal.aborted) setError(errorMessage(error));
              } finally {
                if (!controller.signal.aborted) setPending(false);
              }
            }}
          >
            {pending ? '正在处理…' : '并行对比 JEV / LLM'}
          </button>
        )}
        {task && !paired && ['QUEUED', 'RUNNING'].includes(task.state) && (
          <button
            className="button button-secondary"
            onClick={() => setConfirmCancel(true)}
          >
            取消任务
          </button>
        )}
      </PageHeader>
      {!paired && <RefreshBar {...resource} />}
      <ErrorNotice message={resource.error} />
      <ErrorNotice message={error} />
      {confirmCancel && (
        <div className="confirm-panel" role="alert">
          <p>
            取消后将停止后续操作并请求关闭浏览器。已经发生的业务操作不会被撤销。
          </p>
          <div className="page-actions">
            <button
              className="button button-primary"
              disabled={pending}
              onClick={() => void cancel()}
            >
              {pending ? '取消中…' : '确认取消'}
            </button>
            <button
              className="button button-secondary"
              disabled={pending}
              onClick={() => setConfirmCancel(false)}
            >
              继续执行
            </button>
          </div>
        </div>
      )}
      {!task ? (
        <Empty title={resource.loading ? '正在读取任务…' : '无法读取任务'}>
          {resource.loading ? undefined : '请检查任务 ID、访问凭据和服务连接。'}
        </Empty>
      ) : (
        <>
          <section className="panel task-overview">
            <div className="section-heading">
              <h2>{task.definition.objective}</h2>
              {paired ? (
                <span className="status">两组独立执行</span>
              ) : (
                <Status value={task.state} />
              )}
            </div>
            <dl className="facts">
              <div>
                <dt>执行模式</dt>
                <dd>
                  {paired
                    ? '并行对比'
                    : task.definition.executionMode === 'jev'
                      ? 'LLM + JEV'
                      : '纯 LLM'}
                </dd>
              </div>
              <div>
                <dt>目标地址</dt>
                <dd className="wrap">{task.definition.target.url}</dd>
              </div>
              <div>
                <dt>验证环境 / 节点池</dt>
                <dd>
                  {task.definition.environment.id} /{' '}
                  {task.definition.environment.nodePool}
                </dd>
              </div>
              <div>
                <dt>执行预算</dt>
                <dd>
                  {task.definition.budget.timeoutMs / 1000} 秒 · 最多{' '}
                  {task.definition.budget.maxActions} 次动作
                </dd>
              </div>
            </dl>
          </section>
          {paired ? (
            <Comparison api={api} id={id} />
          ) : (
            <>
              {task.executions.map((execution) => (
                <ExecutionControl
                  key={execution.id}
                  api={api}
                  execution={execution}
                  task={task}
                />
              ))}
              <TaskResources task={task} />
              {task.executions.map((execution) => (
                <DecisionContext
                  key={`context-${execution.id}`}
                  api={api}
                  executionId={execution.id}
                  running={
                    task.state === 'RUNNING' && execution.state === 'RUNNING'
                  }
                />
              ))}
              <TaskReport api={api} task={task} />
              <TaskEvidence api={api} task={task} />
              <TaskDefinition task={task} />
            </>
          )}
        </>
      )}
    </>
  );
}
