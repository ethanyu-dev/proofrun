import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { TaskDetail } from '@proofrun/contracts';
import { ApiClient, errorMessage } from '../api';
import { TaskFields } from '../components/task-fields';
import {
  newTaskDefinition,
  parseTaskDefinition,
  parseCaseBatch,
} from '../task-definition';
import { ErrorNotice, PageHeader } from '../components/ui';

/** 接收上层 Agent 已完成的定义；结构与领域校验最终由控制面执行。 */
export function TaskSubmitPage({ api }: { api: ApiClient }) {
  const [task, setTask] = useState(newTaskDefinition);
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
        mode === 'json' && definition.trimStart().startsWith('[')
          ? parseCaseBatch(definition)
          : parseTaskDefinition(
              mode === 'json' ? definition : JSON.stringify(task),
            );
    } catch (error) {
      setError(errorMessage(error));
      return;
    }
    const controller = new AbortController();
    active.current = controller;
    setPending(true);
    try {
      if (Array.isArray(submitted)) {
        await api.json('/v2/cases', controller.signal, submitted);
        if (!controller.signal.aborted) window.location.hash = '/tasks';
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
        description="填写验证目标与验收标准，也可以切换 JSON 导入完整任务定义。"
      >
        <a className="button button-secondary" href="#/tasks">
          返回任务
        </a>
      </PageHeader>
      <form className="panel task-form" onSubmit={submit}>
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
        <fieldset className="task-editor" disabled={pending}>
          {mode === 'form' ? (
            <TaskFields task={task} change={setTask} />
          ) : (
            <>
              <label htmlFor="task-definition">任务定义 JSON</label>
              <p className="muted">
                支持完整内部任务对象，或 v2 case 数组。数组中每个对象需要
                caseId、platform、entry、steps 和
                cleanup；批量提交后进入任务列表。case 数组请保持 JSON 模式。
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
            同一任务 ID 只接受同一份定义。提交后可能立即开始执行。
          </p>
          <button className="button button-primary" disabled={pending}>
            {pending ? '提交中…' : '提交任务'}
          </button>
        </div>
      </form>
    </>
  );
}
