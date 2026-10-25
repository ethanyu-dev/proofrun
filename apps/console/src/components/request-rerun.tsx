import { toast } from 'sonner';
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
  caseId,
  onComplete,
}: {
  api: ApiClient;
  value: RequestResultV2;
  /** 省略时整体重跑，传入时仅重跑当前请求中的该成员。 */
  caseId?: string;
  /** 成功后刷新原请求，避免仍显示旧运行。 */
  onComplete: () => void;
}) {
  const draft = useRef<RerunInput | null>(null);
  const active = useRef<AbortController | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => () => active.current?.abort(), []);
  const rerun = async () => {
    if (active.current) return;
    draft.current ??= {
      caseIds: value.cases
        .filter((c) => !caseId || c.caseId === caseId)
        .map((c) => ({
          sourceCaseId: c.caseId,
          runId: `run-${crypto.randomUUID()}`,
        })) as RerunInput['caseIds'],
    };
    const controller = new AbortController();
    active.current = controller;
    setPending(true);
    setError(undefined);
    try {
      await api.json<RequestResultV2>(
        `/v2/requests/${encodeURIComponent(value.requestId)}/rerun`,
        controller.signal,
        draft.current,
      );
      if (!controller.signal.aborted) {
        // 仅确认成功后更换身份；网络错误后的重试必须沿用原映射。
        draft.current = null;
        onComplete();
        toast.success(caseId ? '已提交 case 重跑' : '已提交整体重跑');
      }
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
        type="button"
        variant="outline"
        className="button button-secondary"
        disabled={pending || !value.cases.length}
        onClick={() => void rerun()}
        title="在当前请求内新增 LLM 运行，保留 case 身份和历史记录；采用当前预算策略。"
      >
        {pending ? '正在提交重跑…' : caseId ? '重跑此 case' : '重跑整个请求'}
      </Button>
      <ErrorNotice message={error} />
    </div>
  );
}
