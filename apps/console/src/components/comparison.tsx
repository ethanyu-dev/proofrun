import { useEffect, useRef, useState } from 'react';
import type { TaskDetail, ExecutionActivity } from '@proofrun/contracts';
import { ApiClient, errorMessage } from '../api';
import { useResource } from '../use-resource';
import { ErrorNotice, RefreshBar, Status } from './ui';
import { DecisionContext } from './decision-context';
import { ExecutionControl } from './execution-control';
import {
  TaskResources,
  TaskReport,
  TaskEvidence,
  TaskDefinition,
} from './task-sections';
import { ReportSummary } from './report-summary';
import { ReportStatus } from './report-status';

/** 模块顺序在两列保持一致；每个模块的组件状态按任务身份独立挂载。 */
const DETAIL_SECTIONS = [
  { id: 'resources', title: '执行与资源清理' },
  { id: 'context', title: '决策上下文' },
  { id: 'report', title: '验收报告' },
  { id: 'evidence', title: '全部证据' },
  { id: 'definition', title: '原始任务定义' },
] as const;

/** 保留最后一帧供终态对照；重新连接只订阅画面，绝不重发浏览器动作。 */
export function LivePage({
  api,
  execution,
  active,
}: {
  api: ApiClient;
  execution: TaskDetail['executions'][number];
  active: boolean;
}) {
  const latestFrameAt = useRef(0);
  const [frame, setFrame] = useState<string>();
  const [state, setState] = useState('正在连接画面');
  const [count, setCount] = useState(execution.action_count);
  const [frames, setFrames] = useState(0);
  const [capturedAt, setCapturedAt] = useState<number>();
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void api
      .json<{ frame: null | { data: string; capturedAt: number } }>(
        `/v1/admin/executions/${execution.id}/live-frame`,
        controller.signal,
      )
      .then(({ frame }) => {
        if (
          frame &&
          !controller.signal.aborted &&
          frame.capturedAt >= latestFrameAt.current
        ) {
          latestFrameAt.current = frame.capturedAt;
          setFrame(`data:image/jpeg;base64,${frame.data}`);
          setCapturedAt(frame.capturedAt);
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, [api, execution.id, active]);
  useEffect(() => {
    if (!active) {
      setState('执行已结束 · 保留最后画面');
      return;
    }
    // 人工接管期间不争用节点画面；恢复 AUTO 后按控制代次重新订阅。
    // 即使轮询错过短暂的人工状态，递增的代次也能使已关闭的连接重建。
    if (execution.control_mode !== 'AUTO') {
      setState('画面已转交人工处理');
      return;
    }
    let disposed = false;
    let ended = false;
    const socket = api.live(execution.id);
    setState('正在连接画面');
    socket.onmessage = (event) => {
      if (disposed) return;
      try {
        const message = JSON.parse(event.data);
        if (
          message.type === 'frame' &&
          typeof message.data === 'string' &&
          message.data.length < 2 * 1024 * 1024 &&
          /^[A-Za-z0-9+/=]+$/.test(message.data)
        ) {
          latestFrameAt.current = message.capturedAt;
          setFrame(`data:image/jpeg;base64,${message.data}`);
          setCapturedAt(message.capturedAt);
          setFrames((n) => n + 1);
          setState('实时画面');
        } else if (message.type === 'state') setCount(message.actionCount);
        else if (message.type === 'ended' || message.type === 'error') {
          ended = true;
          setState(message.reason ?? message.message);
        }
      } catch {
        setState('画面数据无效');
        socket.close();
      }
    };
    socket.onerror = () => {
      if (!disposed) setState('画面连接失败');
    };
    socket.onclose = () => {
      if (!disposed && !ended) setState('画面连接已断开');
    };
    return () => {
      disposed = true;
      socket.close();
    };
  }, [
    api,
    execution.id,
    execution.control_mode,
    execution.control_revision,
    active,
    version,
  ]);
  return (
    <>
      <div className="comparison-browser-bar">
        <span className={active ? 'live-dot' : 'live-dot ended'} />
        <span>{state}</span>
        <span className="mono">
          {location.protocol === 'https:' ? 'WSS' : 'WS'}
        </span>
      </div>
      <div className="comparison-screen">
        {frame ? (
          <img src={frame} alt="此执行组的浏览器实时画面" />
        ) : (
          <div className="comparison-placeholder">
            <span aria-hidden="true">▣</span>
            <p>{active ? '等待浏览器首帧…' : '本次会话没有保留实时画面'}</p>
          </div>
        )}
      </div>
      <div className="comparison-screen-meta">
        <span>
          已提交 {Math.max(count, execution.action_count)} 次动作 · 接收{' '}
          {frames} 帧
          {capturedAt ? ` · ${new Date(capturedAt).toLocaleTimeString()}` : ''}
        </span>
        {active && execution.control_mode === 'AUTO' && (
          <button
            className="button button-secondary button-small"
            onClick={() => setVersion((v) => v + 1)}
          >
            重新连接画面
          </button>
        )}
      </div>
    </>
  );
}

/** 命令日志来自控制面持久状态，画面刷新不会改变任务进度。 */
function RecentActions({ api, id }: { api: ApiClient; id: string }) {
  const { data, error } = useResource<ExecutionActivity>(
    api,
    `/v1/admin/executions/${id}/activity`,
  );
  return (
    <div className="comparison-activity">
      <ErrorNotice message={error} />
      <p className="muted wrap">
        {data?.observation?.url ?? '等待首次页面观察'}
      </p>
      <ol>
        {data?.commands
          .filter((c) => c.kind.startsWith('browser.'))
          .slice(0, 4)
          .map((c) => (
            <li key={c.id}>
              <span>{c.action ?? c.kind.replace('browser.', '')}</span>
              <span className="muted">{c.status ?? '执行中'}</span>
            </li>
          ))}
      </ol>
    </div>
  );
}

/** 两个独立会话并列，任务状态与验收结论分开呈现，避免把完成当作通过。 */
function Arm({
  api,
  task,
  refresh,
}: {
  api: ApiClient;
  task: TaskDetail;
  refresh: () => void;
}) {
  const jev = task.definition.comparison?.arm === 'jev';
  const execution = task.executions[0];
  const metrics = task.report?.executionDetails;
  return (
    <article className={`comparison-arm ${jev ? 'comparison-jev' : ''}`}>
      <header className="comparison-arm-heading">
        <div>
          <span className="comparison-arm-label">
            {jev ? '实验组 B' : '对照组 A'}
          </span>
          <h3>{jev ? 'JEV + LLM' : '纯 LLM'}</h3>
        </div>
        <div className="comparison-arm-controls">
          {execution && (
            <ExecutionControl api={api} execution={execution} task={task} />
          )}
          <Status value={task.state} />
        </div>
      </header>
      <p className="comparison-description">
        {jev
          ? 'JEV 选择动作，LLM 填写、纠偏与验收'
          : 'LLM 选择操作、填写内容并生成验收报告'}
      </p>
      {execution ? (
        <LivePage
          api={api}
          execution={execution}
          active={
            task.state === 'RUNNING' &&
            ['STARTING', 'RUNNING'].includes(execution.state)
          }
        />
      ) : (
        <div className="comparison-screen comparison-placeholder">
          <p>排队中，等待独立浏览器会话</p>
        </div>
      )}
      <div className="comparison-stats">
        <div>
          <span>模型请求</span>
          <strong>{metrics?.modelCalls ?? '—'}</strong>
        </div>
        <div>
          <span>动作</span>
          <strong>{metrics?.actions ?? execution?.action_count ?? 0}</strong>
        </div>
        <div>
          <span>执行耗时</span>
          <strong>
            {metrics ? `${(metrics.elapsedMs / 1000).toFixed(1)}s` : '—'}
          </strong>
        </div>
        <div>
          <span>验收结论</span>
          <ReportStatus value={task.reportStatus} />
        </div>
      </div>
      {metrics && (
        <p className="muted comparison-description">
          已记录 token：{metrics.promptTokens.toLocaleString()} 输入 /{' '}
          {metrics.completionTokens.toLocaleString()} 输出
        </p>
      )}
      {!!metrics?.modelUsage?.length && (
        <details className="comparison-models">
          <summary>模型调用分项</summary>
          {metrics.modelUsage.map((u) => (
            <p key={u.model}>
              {u.model} · {u.calls} 次 · {u.promptTokens} / {u.completionTokens}{' '}
              token
            </p>
          ))}
        </details>
      )}
      {execution && (
        <>
          <p className="muted mono comparison-session">
            会话 {execution.session_id.slice(0, 8)} · 节点{' '}
            {execution.node_id.slice(0, 8)}
          </p>
          <RecentActions api={api} id={execution.id} />
        </>
      )}
      {task.report && (
        <details className="comparison-models">
          <summary>此组报告摘要</summary>
          <ReportSummary text={task.report.summary} />
        </details>
      )}
      {task.error && (
        <p className="error-notice" role="alert">
          {task.report?.summary ?? '执行失败，请查看验收报告与决策上下文。'}
          <br />
          {JSON.stringify(task.error)}
        </p>
      )}
      <div className="comparison-arm-actions">
        <button
          className="button button-secondary button-small"
          onClick={() =>
            document
              .getElementById(
                `comparison-report-${task.definition.comparison?.arm}`,
              )
              ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
          }
        >
          查看本组验收报告 ↓
        </button>
        <CancelArm api={api} task={task} refresh={refresh} />
      </div>
    </article>
  );
}

/** 单组取消明确标注作用范围，确认不会对另一组发出请求。 */
function CancelArm({
  api,
  task,
  refresh,
}: {
  api: ApiClient;
  task: TaskDetail;
  refresh: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  if (!['QUEUED', 'RUNNING'].includes(task.state)) return null;
  return (
    <div>
      <ErrorNotice message={error} />
      {!confirm ? (
        <button
          className="button button-secondary button-small"
          onClick={() => setConfirm(true)}
        >
          取消本组
        </button>
      ) : (
        <div className="confirm-panel" role="alert">
          <p>
            将停止
            {task.definition.comparison?.arm === 'jev'
              ? '实验组 B（JEV + LLM）'
              : '对照组 A（纯 LLM）'}
            并请求关闭本组浏览器。
          </p>
          <div className="page-actions">
            <button
              className="button button-secondary button-small"
              disabled={pending}
              onClick={() => setConfirm(false)}
            >
              继续执行
            </button>
            <button
              className="button button-primary button-small"
              disabled={pending}
              onClick={async () => {
                if (active.current) return;
                const controller = new AbortController();
                active.current = controller;
                setPending(true);
                setError(undefined);
                try {
                  await api.json(
                    `/v1/tasks/${encodeURIComponent(task.id)}/cancel`,
                    controller.signal,
                    {},
                  );
                  if (!controller.signal.aborted) {
                    setConfirm(false);
                    refresh();
                  }
                } catch (error) {
                  if (!controller.signal.aborted) setError(errorMessage(error));
                } finally {
                  active.current = null;
                  if (!controller.signal.aborted) setPending(false);
                }
              }}
            >
              {pending ? '取消中…' : '确认取消本组'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** 各模块只消费所在列的任务；轮次和调用选择独立，避免暗示不同策略逐轮对应。 */
export function ComparisonDetails({
  api,
  arms,
}: {
  api: ApiClient;
  arms: TaskDetail[];
}) {
  return (
    <div className="comparison-details">
      <nav className="comparison-detail-nav" aria-label="对照详情模块">
        {DETAIL_SECTIONS.map((section) => (
          <button
            key={section.id}
            className="button button-secondary button-small"
            onClick={() =>
              document
                .getElementById(`comparison-${section.id}`)
                ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }
          >
            {section.title}
          </button>
        ))}
      </nav>
      {DETAIL_SECTIONS.map((section) => (
        <section
          key={section.id}
          id={`comparison-${section.id}`}
          className="comparison-grid comparison-detail-row"
          aria-label={`${section.title}对照`}
        >
          {arms.map((task) => {
            const jev = task.definition.comparison?.arm === 'jev';
            return (
              <article
                key={task.id}
                className={`comparison-detail-arm ${jev ? 'comparison-jev' : ''}`}
                data-task-id={task.id}
                aria-label={`${jev ? '实验组 B · JEV + LLM' : '对照组 A · 纯 LLM'} · ${section.title}`}
                id={
                  section.id === 'report'
                    ? `comparison-report-${task.definition.comparison?.arm}`
                    : undefined
                }
              >
                <header className="comparison-detail-heading">
                  <strong>
                    {jev ? '实验组 B · JEV + LLM' : '对照组 A · 纯 LLM'}
                  </strong>
                  <span className="mono muted wrap">{task.id}</span>
                </header>
                {section.id === 'resources' && <TaskResources task={task} />}
                {section.id === 'context' && !task.executions.length && (
                  <section className="panel">
                    <h2>{section.title}</h2>
                    <p className="muted">尚未分配执行，等待本组浏览器会话。</p>
                  </section>
                )}
                {section.id === 'context' &&
                  task.executions.map((execution) => (
                    <DecisionContext
                      key={execution.id}
                      api={api}
                      executionId={execution.id}
                      running={
                        task.state === 'RUNNING' &&
                        execution.state === 'RUNNING'
                      }
                    />
                  ))}
                {section.id === 'report' && (
                  <TaskReport api={api} task={task} />
                )}
                {section.id === 'evidence' && (
                  <TaskEvidence api={api} task={task} />
                )}
                {section.id === 'definition' && <TaskDefinition task={task} />}
              </article>
            );
          })}
        </section>
      ))}
    </div>
  );
}

/** 当前任务决定所属对照组，读取失败时保留错误，不回退成无标识的单组详情。 */
export function Comparison({ api, id }: { api: ApiClient; id: string }) {
  const resource = useResource<{
    comparison: null | { id: string; sourceTaskId: string; arms: TaskDetail[] };
  }>(api, `/v1/tasks/${encodeURIComponent(id)}/comparison`);
  const comparison = resource.data?.comparison;
  return (
    <>
      <section className="comparison-section" aria-label="JEV 与 LLM 并行对比">
        <div className="section-heading">
          <div>
            <p className="comparison-eyebrow">同一任务 · 独立会话</p>
            <h2>并行执行对比</h2>
          </div>
          <span className="status">对照组 A / 实验组 B</span>
        </div>
        <p className="muted">
          两组使用相同目标、验收标准和预算。以下所有模块均按组展示；模型调用可分别选择，轮次不强行对应。
        </p>
        <RefreshBar {...resource} />
        <ErrorNotice message={resource.error} />
        {!comparison && (
          <p className="muted">
            {resource.loading
              ? '正在读取两组执行…'
              : '暂时无法读取对照任务，请刷新重试。'}
          </p>
        )}
        <div className="comparison-grid">
          {comparison?.arms.map((task) => (
            <Arm
              key={task.id}
              api={api}
              task={task}
              refresh={resource.refresh}
            />
          ))}
        </div>
      </section>
      {comparison && (
        <ComparisonDetails
          key={comparison.id}
          api={api}
          arms={comparison.arms}
        />
      )}
    </>
  );
}
