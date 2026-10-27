import { useEffect, useRef, useState } from 'react';
import type { TaskDetail } from '@proofrun/contracts';
import { ApiClient, errorMessage } from '../api';
import {
  actionLabel,
  playbackSteps,
  type PlaybackStep,
} from '../execution-timeline';
import { useExecutionTimeline } from '../use-execution-timeline';
import { ExecutionControl } from './execution-control';
import { LivePage } from './live-page';
import { Button } from './ui/button';
import { ErrorNotice, Status } from './ui';

/** 操作结果与业务验收结论不同，禁止将 FAILED 标成验收失败。 */
const OPERATION_STATUS: Record<string, string> = {
  SUCCEEDED: '操作完成',
  FAILED: '操作失败',
  TIMED_OUT: '操作超时',
  CANCELLED: '已取消',
  REJECTED: '已拒绝',
  RUNNING: '执行中',
};

/** 只展示当前执行的实时画面与步骤记录；主动选择步骤后不被轮询抢回实时页。 */
export function StepPlayback({
  api,
  task,
  execution,
}: {
  api: ApiClient;
  task: TaskDetail;
  execution: TaskDetail['executions'][number];
}) {
  const browser = task.definition.taskKind === 'browser';
  const active =
    task.state === 'RUNNING' &&
    ['STARTING', 'RUNNING'].includes(execution.state);
  const timeline = useExecutionTimeline(api, execution.id, active);
  const steps = playbackSteps(task, timeline.commands);
  const [selection, setSelection] = useState<string | null>(null);
  const live = active && selection === null;
  const step = steps.find((s) => s.id === selection) ?? steps[0];
  return (
    <>
      {/* 人工处理属于当前执行，不随浏览器任务的画面与记录切换隐藏。 */}
      {browser && (
        <ExecutionControl api={api} task={task} execution={execution} />
      )}
      <div className="execution-workspace">
        <nav
          className="execution-steps"
          aria-label={browser ? '执行记录' : '执行步骤'}
        >
          {active && (
            <Button
              variant={live ? 'secondary' : 'ghost'}
              onClick={() => setSelection(null)}
              aria-current={live ? 'true' : undefined}
            >
              实时画面
            </Button>
          )}
          <h2>{browser ? '执行记录' : '步骤'}</h2>
          {steps.map((item, index) => (
            <button
              type="button"
              className="execution-step"
              key={item.id}
              aria-current={!live && item.id === step?.id ? 'step' : undefined}
              onClick={() => setSelection(item.id)}
            >
              <span className="execution-step-title">
                <strong>
                  {browser
                    ? '操作记录'
                    : item.id === 'unassigned'
                      ? '其他操作'
                      : `Step ${index + 1}`}
                  {task.definition.cleanupStepIds?.includes(item.id)
                    ? ' · 清理'
                    : ''}
                </strong>
                <Status
                  value={
                    item.result?.status ??
                    (item.id === 'unassigned' ? '已记录' : 'PENDING')
                  }
                />
              </span>
              <span className="execution-step-description">
                {item.description}
              </span>
              <small>
                {item.screenshots.length} 张截图 · {item.commands.length} 条操作
              </small>
            </button>
          ))}
        </nav>
        <section
          className="execution-stage"
          aria-label={live ? '实时交互' : browser ? '操作回放' : '步骤回放'}
        >
          {live ? (
            <>
              <div className="section-heading">
                <h2>实时画面</h2>
              </div>
              {!browser && (
                <ExecutionControl api={api} task={task} execution={execution} />
              )}
              <LivePage api={api} execution={execution} active={active} />
              <p className="muted">
                {browser
                  ? execution.control_mode === 'HUMAN'
                    ? '等待人工处理，完成后继续执行任务。'
                    : execution.control_mode === 'REQUESTED'
                      ? '正在交接浏览器控制权…'
                      : timeline.commands.length
                        ? `最近操作：${actionLabel(timeline.commands.at(-1)!)}`
                        : execution.state === 'STARTING'
                          ? '正在启动浏览器…'
                          : '正在执行任务，等待操作记录…'
                  : (steps.find((s) => s.result?.status === 'RUNNING')
                      ?.description ?? '正在准备执行…')}
              </p>
            </>
          ) : step ? (
            <StepRecording
              key={step.id}
              api={api}
              step={step}
              browser={browser}
            />
          ) : (
            <p className="muted">尚无步骤记录。</p>
          )}
          <ErrorNotice message={timeline.error} />
          {timeline.loading && (
            <p role="status" className="muted">
              正在同步操作记录…
            </p>
          )}
          {timeline.error && (
            <Button variant="outline" onClick={timeline.refresh}>
              重新读取操作
            </Button>
          )}
          {live && (
            <OperationList
              commands={timeline.commands.slice(-12)}
              onScreenshot={(id) =>
                setSelection(
                  steps.find((item) =>
                    item.screenshots.some((image) => image.id === id),
                  )?.id ?? null,
                )
              }
            />
          )}
        </section>
      </div>
    </>
  );
}

/** 单步骤截图和操作共用选择状态，操作产生的截图可以直接定位。 */
function StepRecording({
  api,
  step,
  browser,
}: {
  api: ApiClient;
  step: PlaybackStep;
  browser: boolean;
}) {
  const [selected, setSelected] = useState<string>();
  const screen = useRef<HTMLDivElement>(null);
  const index = Math.max(
    0,
    step.screenshots.findIndex((s) => s.id === selected),
  );
  const screenshot = step.screenshots[index];
  return (
    <>
      <div className="section-heading">
        <h2>
          {browser
            ? '操作记录'
            : step.id === 'unassigned'
              ? '其他操作'
              : step.id}
        </h2>
        {step.result && <Status value={step.result.status} />}
      </div>
      <p className="execution-step-instruction">{step.description}</p>
      <div ref={screen} className="execution-screenshot-anchor">
        {screenshot ? (
          <>
            <Screenshot key={screenshot.id} api={api} screenshot={screenshot} />
            <div className="execution-image-controls">
              <Button
                variant="outline"
                disabled={index === 0}
                onClick={() => setSelected(step.screenshots[index - 1]!.id)}
              >
                上一张
              </Button>
              <span>
                {index + 1} / {step.screenshots.length} 张截图
              </span>
              <Button
                variant="outline"
                disabled={index === step.screenshots.length - 1}
                onClick={() => setSelected(step.screenshots[index + 1]!.id)}
              >
                下一张
              </Button>
            </div>
          </>
        ) : (
          <div className="execution-image-empty">
            {browser
              ? '本次执行尚无截图记录'
              : step.result?.status === 'PENDING' || !step.result
                ? '此步骤尚无截图记录'
                : '此步骤没有保存截图'}
          </div>
        )}
      </div>
      <OperationList
        commands={step.commands}
        onScreenshot={(id) => {
          setSelected(id);
          screen.current?.scrollIntoView({
            behavior: 'smooth',
            block: 'start',
          });
        }}
      />
      {!!step.commands.length && step.id !== 'unassigned' && (
        <p className="muted note">操作按浏览器分组与步骤起止时间归属。</p>
      )}
    </>
  );
}

/** 截图只通过认证、摘要校验接口读取；切换图片释放资源，失败提供重试而不借用其他步骤截图。 */
function Screenshot({
  api,
  screenshot,
}: {
  api: ApiClient;
  screenshot: PlaybackStep['screenshots'][number];
}) {
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState<string>();
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (screenshot.state !== 'AVAILABLE') return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    setUrl(undefined);
    setError(undefined);
    void api
      .artifact(
        screenshot.id,
        'SCREENSHOT',
        screenshot.sha256,
        controller.signal,
      )
      .then((blob) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(errorMessage(error));
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [api, screenshot.id, screenshot.sha256, screenshot.state, version]);
  if (screenshot.state !== 'AVAILABLE')
    return (
      <div className="execution-image-empty">
        {screenshot.state === 'PENDING' ? '截图正在保存' : '截图已归档或不可用'}
      </div>
    );
  return (
    <div className="execution-image">
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          aria-label="查看原尺寸截图"
        >
          <img src={url} alt="当前步骤的页面截图" />
        </a>
      ) : (
        <div className="execution-image-empty">
          {error ? (
            <>
              <ErrorNotice message={error} />
              <Button
                variant="outline"
                onClick={() => setVersion((v) => v + 1)}
              >
                重试截图
              </Button>
            </>
          ) : (
            '正在读取截图…'
          )}
        </div>
      )}
    </div>
  );
}

/** 只列实际浏览器命令；观察与执行动作分开命名，失败和人工操作保留原始状态。 */
function OperationList({
  commands,
  onScreenshot,
}: {
  commands: PlaybackStep['commands'];
  onScreenshot: (id: string) => void;
}) {
  return (
    <section className="execution-operations" aria-label="操作记录">
      <h3>操作记录</h3>
      {!commands.length ? (
        <p className="muted">暂无操作记录。</p>
      ) : (
        <ol>
          {commands.map((command) => (
            <li key={command.id}>
              <time dateTime={command.created_at}>
                {new Date(command.created_at).toLocaleTimeString()}
              </time>
              <span>
                {actionLabel(command)}
                {command.actor === 'HUMAN' ? ' · 人工' : ''}
                {command.error && (
                  <small className="wrap">{command.error}</small>
                )}
              </span>
              <span className="muted">
                {OPERATION_STATUS[command.status ?? 'RUNNING'] ??
                  command.status}
              </span>
              {command.screenshots.length > 0 && (
                <Button
                  variant="ghost"
                  onClick={() => onScreenshot(command.screenshots[0]!.id)}
                >
                  查看截图
                </Button>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
