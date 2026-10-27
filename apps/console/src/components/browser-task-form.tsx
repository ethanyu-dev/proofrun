import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { BrowserTaskRequest, TaskDetail } from '@proofrun/contracts';
import { ApiClient, errorMessage } from '../api';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { ErrorNotice } from './ui';

/** 只收集业务目标；保持最近提交身份，网络结果未知时不会创建重复执行。 */
export function BrowserTaskForm({ api }: { api: ApiClient }) {
  const [url, setUrl] = useState('');
  const [objective, setObjective] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const submitted = useRef<BrowserTaskRequest | null>(null);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (active.current) return;
    setError(undefined);
    const target = url.trim();
    const goal = objective.trim();
    if (!/^https?:\/\//.test(target) || !goal) {
      setError('请填写 HTTP(S) 网址和任务目标。');
      return;
    }
    if (
      submitted.current?.url !== target ||
      submitted.current?.objective !== goal
    )
      submitted.current = {
        taskId: `browser-${crypto.randomUUID()}`,
        url: target,
        objective: goal,
      };
    const controller = new AbortController();
    active.current = controller;
    setPending(true);
    try {
      const result = await api.json<TaskDetail>(
        '/v1/browser-tasks',
        controller.signal,
        submitted.current,
      );
      if (!controller.signal.aborted)
        window.location.hash = `/browser-tasks/${encodeURIComponent(result.id)}`;
    } catch (error) {
      if (!controller.signal.aborted) setError(errorMessage(error));
    } finally {
      active.current = null;
      if (!controller.signal.aborted) setPending(false);
    }
  };
  return (
    <form onSubmit={submit} aria-label="浏览器任务">
      <fieldset className="task-editor task-section" disabled={pending}>
        <label htmlFor="browser-url">目标网址</label>
        <Input
          id="browser-url"
          type="url"
          required
          maxLength={8192}
          placeholder="https://example.com"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
        <label htmlFor="browser-objective">任务目标</label>
        <Textarea
          id="browser-objective"
          required
          maxLength={20000}
          rows={6}
          placeholder="描述需要完成的操作或查询，以及希望返回的结果。"
          value={objective}
          onChange={(event) => setObjective(event.target.value)}
        />
      </fieldset>
      <p className="muted">
        使用独立浏览器会话执行，返回结果正文和证据；需要登录时按平台配置请求人工辅助。
      </p>
      <ErrorNotice message={error} />
      <div className="form-footer">
        <Button disabled={pending}>{pending ? '提交中…' : '提交任务'}</Button>
      </div>
    </form>
  );
}
