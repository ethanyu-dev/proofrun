import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { TaskDetail } from '@proofrun/contracts';
import { ApiClient, errorMessage } from '../api';
import { TaskFields } from '../components/task-fields';
import {
  submitCaseBatch,
  submitVerificationRequest,
} from '../components/task-submit-request';
import {
  newTaskDefinition,
  parseTaskDefinition,
  parseCaseBatch,
  parseVerificationRequest,
} from '../task-definition';
import { ErrorNotice, PageHeader } from '../components/ui';

/** 接收上层 Agent 已完成的定义；结构与领域校验最终由控制面执行。 */
export function TaskSubmitPage({ api }: { api: ApiClient }) {
  const [task, setTask] = useState(newTaskDefinition);
  const [version, setVersion] = useState<'v2' | 'v1'>('v2');
  const [caseDefinition, setCaseDefinition] = useState('');
  const [mode, setMode] = useState<'form' | 'json'>('form');
  const [definition, setDefinition] = useState('');
  // 切换前验证 JSON，失败时保留用户原文，不用旧表单覆盖输入。
  const switchMode = (next: 'form' | 'json') => {
    if (next === mode) return;
    try {
      if (next === 'json') setDefinition(JSON.stringify(task, null, 2));
      else if (definition !== JSON.stringify(task, null, 2))
        setTask(parseTaskDefinition(definition));
      setMode(next);
      setError(undefined);
    } catch (error) {
      setError(errorMessage(error));
    }
  };
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    setError(undefined);
    let submitted;
    try {
      submitted =
        version === 'v2'
          ? parseVerificationRequest(caseDefinition)
          : mode === 'json' && definition.trimStart().startsWith('[')
            ? parseCaseBatch(definition)
            : parseTaskDefinition(
                mode === 'json' ? definition : JSON.stringify(task),
              );
      // 发送前把生成的身份写回草稿；网络结果未知时重提不会创建另一批任务。
      if ('requestId' in submitted)
        setCaseDefinition(JSON.stringify(submitted, null, 2));
      if (Array.isArray(submitted)) {
        const normalized = JSON.stringify(submitted, null, 2);
        if (version === 'v2') setCaseDefinition(normalized);
        else setDefinition(normalized);
      }
    } catch (error) {
      setError(errorMessage(error));
      return;
    }
    const controller = new AbortController();
    active.current = controller;
    setPending(true);
    try {
      if ('requestId' in submitted) {
        const path = await submitVerificationRequest(
          api,
          submitted,
          controller.signal,
        );
        if (!controller.signal.aborted) window.location.hash = path;
        return;
      }
      if (Array.isArray(submitted)) {
        const path = await submitCaseBatch(api, submitted, controller.signal);
        if (!controller.signal.aborted) window.location.hash = path;
        return;
      }
      const result = await api.json<TaskDetail>(
        '/v1/tasks',
        controller.signal,
        submitted,
      );
      if (!controller.signal.aborted)
        window.location.hash = `/tasks/${encodeURIComponent(result.id)}`;
    } catch (error) {
      if (!controller.signal.aborted) setError(errorMessage(error));
    } finally {
      if (!controller.signal.aborted) setPending(false);
    }
  };
  return (
    <>
      <PageHeader
        title="提交验证任务"
        description="粘贴 v2 Schema 文件中的 JSON 内容，即可批量提交验证任务。"
      >
        <a className="button button-secondary" href="#/tasks">
          返回任务
        </a>
      </PageHeader>
      <form className="panel task-form" onSubmit={submit}>
        <div className="mode-switch" role="group" aria-label="提交版本">
          <button
            type="button"
            className={`button ${version === 'v2' ? 'button-primary' : 'button-secondary'}`}
            aria-pressed={version === 'v2'}
            disabled={pending}
            onClick={() => {
              setVersion('v2');
              setError(undefined);
            }}
          >
            v2 Schema 提交
          </button>
          <button
            type="button"
            className={`button ${version === 'v1' ? 'button-primary' : 'button-secondary'}`}
            aria-pressed={version === 'v1'}
            disabled={pending}
            onClick={() => {
              setVersion('v1');
              setError(undefined);
            }}
          >
            v1 兼容入口
          </button>
        </div>
        {version === 'v1' && (
          <div className="mode-switch" role="group" aria-label="任务编辑模式">
            <button
              type="button"
              className={`button ${mode === 'form' ? 'button-primary' : 'button-secondary'}`}
              aria-pressed={mode === 'form'}
              disabled={pending}
              onClick={() => switchMode('form')}
            >
              表单模式
            </button>
            <button
              type="button"
              className={`button ${mode === 'json' ? 'button-primary' : 'button-secondary'}`}
              aria-pressed={mode === 'json'}
              disabled={pending}
              onClick={() => switchMode('json')}
            >
              JSON 模式
            </button>
          </div>
        )}
        <fieldset className="task-editor" disabled={pending}>
          {version === 'v2' ? (
            <>
              <label htmlFor="case-definition">v2 Schema JSON</label>
              <p className="muted" id="case-definition-help">
                粘贴包含 platform、entry、steps、cleanup 的 case 数组，一次最多
                32 个；也可粘贴包含 requestId、title、cases
                的请求对象。数组会自动生成请求身份，缺少的 caseId 自动生成。
              </p>
              <p className="muted">
                默认使用 LLM + JEV
                单组执行、自动复用本站登录状态、允许人工辅助。
                执行设置由平台配置管理，可显式选择纯 LLM 或双跑对比。
              </p>
              <textarea
                id="case-definition"
                aria-describedby="case-definition-help"
                className="mono"
                value={caseDefinition}
                onChange={(event) => setCaseDefinition(event.target.value)}
                placeholder="在此粘贴 v2 Schema 文件的 JSON 数组内容"
                required
                spellCheck={false}
                rows={22}
                maxLength={1_500_000}
              />
            </>
          ) : mode === 'form' ? (
            <TaskFields task={task} change={setTask} />
          ) : (
            <>
              <label htmlFor="task-definition">任务定义 JSON</label>
              <p className="muted">
                支持完整内部任务对象，或 v2 case 数组。数组中每个对象需要
                platform、entry、steps 和 cleanup；批量提交后进入任务列表。case
                数组请保持 JSON 模式。
              </p>
              <textarea
                id="task-definition"
                className="mono"
                value={definition}
                onChange={(event) => setDefinition(event.target.value)}
                required
                spellCheck={false}
                rows={22}
                maxLength={1_500_000}
              />
            </>
          )}
        </fieldset>
        <ErrorNotice message={error} />
        <div className="form-footer">
          <p className="muted">
            {version === 'v2'
              ? '提交后进入请求详情，按 case 查看两组执行和汇总报告。自动生成的 requestId、caseId 会保留在输入框中；网络失败后沿用原身份重试。'
              : '同一任务 ID 只接受同一份定义。'}
            提交后可能立即开始执行。
          </p>
          <button className="button button-primary" disabled={pending}>
            {pending ? '提交中…' : '提交任务'}
          </button>
        </div>
      </form>
    </>
  );
}
