import { Button } from './ui/button';
import { useEffect, useRef, useState } from 'react';
import type {
  RequestResultV2,
  RequestRerun as RerunInput,
} from '@proofrun/contracts';
import { errorMessage, type ApiClient } from '../api';
import { ErrorNotice } from './ui';

/** 同一次点击后的未知响应重试沿用全部目标身份，不在客户端循环提交 case。 */
export function RequestRerun({
  api,
  value,
}: {
  api: ApiClient;
  value: RequestResultV2;
}) {
  const draft = useRef<RerunInput | null>(null);
  const active = useRef<AbortController | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => () => active.current?.abort(), []);
  const rerun = async () => {
    if (active.current) return;
    draft.current ??= {
      requestId: `request-${crypto.randomUUID()}`,
      caseIds: value.cases.map((c) => ({
        sourceCaseId: c.caseId,
        runId: `run-${crypto.randomUUID()}`,
      })) as RerunInput['caseIds'],
    };
    const controller = new AbortController();
    active.current = controller;
    setPending(true);
    setError(undefined);
    try {
      const result = await api.json<RequestResultV2>(
        `/v2/requests/${encodeURIComponent(value.requestId)}/rerun`,
        controller.signal,
        draft.current,
      );
      if (!controller.signal.aborted)
        location.hash = `/requests/${encodeURIComponent(result.requestId)}`;
    } catch (error) {
      if (!controller.signal.aborted) setError(errorMessage(error));
    } finally {
      active.current = null;
      if (!controller.signal.aborted) setPending(false);
    }
  };
  return (
    <div>
      <Button
        variant="outline"
        className="button button-secondary"
        disabled={pending || !value.cases.length}
        onClick={() => void rerun()}
        title="沿用各 case 冻结环境与执行模式，创建新请求及运行记录；采用当前预算策略。"
      >
        {pending ? '正在创建重跑请求…' : '重跑整个请求'}
      </Button>
      <ErrorNotice message={error} />
    </div>
  );
}
