import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from '../components/ui/tabs';
import { Button } from '../components/ui/button';
import { Textarea } from '../components/ui/textarea';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiClient, errorMessage } from '../api';
import { BrowserTaskForm } from '../components/browser-task-form';
import { submitVerificationRequest } from '../components/task-submit-request';
import { parseVerificationRequest } from '../task-definition';
import { ErrorNotice, PageHeader } from '../components/ui';

/** 接收上层 Agent 已完成的定义；结构与领域校验最终由控制面执行。 */
export function TaskSubmitPage({
  api,
  initialKind = 'v2',
}: {
  api: ApiClient;
  initialKind?: 'v2' | 'browser';
}) {
  const [version, setVersion] = useState(initialKind);
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
      // 发送前冻结请求身份；网络失败后重提仍沿用同一份定义。
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
        title="提交任务"
        description="选择结构化验证任务，或直接描述浏览器需要完成的目标。"
      >
        <Button asChild variant="outline">
          <a
            className="button button-secondary"
            href={version === 'browser' ? '#/browser-tasks' : '#/tasks'}
          >
            返回任务
          </a>
        </Button>
      </PageHeader>
      <div className="panel task-form">
        <Tabs
          value={version}
          onValueChange={(value) => {
            setVersion(value as 'browser' | 'v2');
            setError(undefined);
          }}
        >
          <TabsList aria-label="任务类型">
            <TabsTrigger value="v2" disabled={pending}>
              v2 Schema 提交
            </TabsTrigger>
            <TabsTrigger value="browser" disabled={pending}>
              浏览器任务
            </TabsTrigger>
          </TabsList>
          <TabsContent value="v2" forceMount hidden={version !== 'v2'}>
            <form onSubmit={submit}>
              <fieldset className="task-editor" disabled={pending}>
                <label htmlFor="case-definition">v2 Schema JSON</label>
                <p className="muted" id="case-definition-help">
                  粘贴包含 platform、entry、steps、cleanup 的 case
                  数组，一次最多 32 个；也可粘贴包含 requestId、title、cases
                  的请求对象。数组会自动生成请求身份，缺少的 caseId 自动生成。
                </p>
                <p className="muted">
                  使用 LLM
                  单组执行，按测试身份来源准备独立会话；人工辅助由平台配置授权。
                </p>
                <Textarea
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
                  提交后进入请求详情。自动生成的 requestId、caseId
                  会保留在输入框中；网络失败后沿用原身份重试。
                  提交后可能立即开始执行。
                </p>
                <Button
                  variant="default"
                  className="button button-primary"
                  disabled={pending}
                >
                  {pending ? '提交中…' : '提交任务'}
                </Button>
              </div>
            </form>
          </TabsContent>
          <TabsContent
            value="browser"
            forceMount
            hidden={version !== 'browser'}
          >
            <BrowserTaskForm api={api} />
          </TabsContent>
        </Tabs>
      </div>
    </>
  );
}
