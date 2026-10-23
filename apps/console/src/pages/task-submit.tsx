import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiClient, errorMessage } from '../api';
import { submitVerificationRequest } from '../components/task-submit-request';
import { parseVerificationRequest } from '../task-definition';
import { ErrorNotice, PageHeader } from '../components/ui';

/** 接收上层 Agent 已完成的定义；结构与领域校验最终由控制面执行。 */
export function TaskSubmitPage({ api }: { api: ApiClient }) {
  const [caseDefinition, setCaseDefinition] = useState('');
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
      submitted = parseVerificationRequest(caseDefinition);
      // 发送前把生成的身份写回草稿；网络结果未知时重提不会创建另一批任务。
      setCaseDefinition(JSON.stringify(submitted, null, 2));
    } catch (error) {
      setError(errorMessage(error));
      return;
    }
    const controller = new AbortController();
    active.current = controller;
    setPending(true);
    try {
      const path = await submitVerificationRequest(
        api,
        submitted,
        controller.signal,
      );
      if (!controller.signal.aborted) window.location.hash = path;
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
        <fieldset className="task-editor" disabled={pending}>
          <label htmlFor="case-definition">v2 Schema JSON</label>
          <p className="muted" id="case-definition-help">
            粘贴包含 platform、entry、steps、cleanup 的 case 数组，一次最多 32
            个；也可粘贴包含 requestId、title、cases
            的请求对象。数组会自动生成请求身份，缺少的 caseId 自动生成。
          </p>
          <p className="muted">
            默认使用 LLM + JEV 单组执行、自动复用本站登录状态、允许人工辅助。
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
        </fieldset>
        <ErrorNotice message={error} />
        <div className="form-footer">
          <p className="muted">
            提交后进入请求详情，按 case 查看执行和报告。自动生成的
            requestId、caseId 会保留在输入框中；网络失败后沿用原身份重试。
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
