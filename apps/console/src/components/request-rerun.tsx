import { toast } from 'sonner';
import { Button } from './ui/button';
import { useEffect, useRef, useState } from 'react';
import type {
  RequestResultV2,
  SessionRequest,
  RequestRerun as RerunInput,
} from '@proofrun/contracts';
import { ApiError, errorMessage, type ApiClient } from '../api';
import { RerunDialog } from './rerun-dialog';

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
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => () => active.current?.abort(), []);
  const rerun = async (
    sessions: Record<string, SessionRequest | undefined>,
  ) => {
    if (active.current) return;
    draft.current ??= {
      caseIds: value.cases
        .filter((c) => !caseId || c.caseId === caseId)
        .map((c) => ({
          sourceCaseId: c.caseId,
          runId: `run-${crypto.randomUUID()}`,
          ...(sessions[c.caseId] ? { session: sessions[c.caseId] } : {}),
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
        setOpen(false);
        onComplete();
        toast.success(caseId ? '已提交 case 重跑' : '已提交整体重跑');
      }
    } catch (error) {
      // 明确拒绝且未接收的请求可修改配置；网络和服务端未知结果继续冻结请求。
      if (
        error instanceof ApiError &&
        [400, 401, 403, 404, 409, 410, 422].includes(error.status)
      )
        draft.current = null;
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
        onClick={() => setOpen(true)}
        title="在当前请求内新增 LLM 运行，保留 case 身份和历史记录；采用当前预算策略。"
      >
        {pending ? '正在提交重跑…' : caseId ? '重跑此 case' : '重跑整个请求'}
      </Button>
      <RerunDialog
        open={open}
        items={value.cases
          .filter((c) => !caseId || c.caseId === caseId)
          .map((c) => ({ id: c.caseId, title: c.title }))}
        pending={pending}
        locked={!!draft.current}
        error={error}
        close={() => setOpen(false)}
        submit={(sessions) => void rerun(sessions)}
      />
    </div>
  );
}
