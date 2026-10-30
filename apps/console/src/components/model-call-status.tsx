import { useEffect, useState } from 'react';
import type { ModelCall } from '@proofrun/contracts';
import { ApiClient } from '../api';
import { useResource } from '../use-resource';
import { ErrorNotice } from './ui';
import { Button } from './ui/button';

/** 只在有在途请求时更新本地计时；服务器元数据仍按资源轮询频率同步。 */
const CLOCK_MS = 1000;
/** 列表接口刻意省略大正文，页面不为了诊断下载提示词或模型输出。 */
export type ModelCallMetadata = Omit<ModelCall, 'request' | 'response'>;
/** 固定分类摘要不会渲染供应商原始错误页或其中的敏感信息。 */
const REASONS = {
  RATE_LIMITED: '模型服务限流',
  GATEWAY_TIMEOUT: '网关或上游超时',
  UPSTREAM_UNAVAILABLE: '上游服务异常',
  AUTH_REJECTED: '认证或权限被拒绝',
  CONTEXT_LIMIT: '上下文或输出额度超限',
  INVALID_RESPONSE: '响应格式不符合预期',
  REQUEST_TIMEOUT: '请求达到超时上限',
  TRANSPORT_FAILURE: '连接或响应传输中断',
  RESPONSE_TOO_LARGE: '响应超过读取上限',
};
/** 等待响应头阶段包含建连，不凭单一 REQUEST 状态推断网络根因。 */
const PHASES = {
  REQUEST: '建连或等待响应头',
  RESPONSE_BODY: '读取响应正文',
  RESPONSE_PARSE: '解析响应 JSON',
  HTTP_STATUS: '检查 HTTP 状态',
};

/** 实际耗时用回执；在途等待用开始时间估算，终态缺失回执不继续计时。 */
export function modelCallDuration(
  call: ModelCallMetadata,
  active: boolean,
  now: number,
): string {
  if (call.elapsedMs !== null)
    return `${(call.elapsedMs / 1000).toFixed(1)} 秒`;
  if (call.status === 'PENDING' && active)
    return `${Math.max(0, Math.floor((now - Date.parse(call.startedAt)) / 1000))} 秒`;
  return '耗时未记录';
}

/** 只有执行器记录的尝试编号才解释为重试，不能拿全局 callIndex 代替。 */
function attemptLabel(call: ModelCallMetadata): string {
  if (call.attempt === undefined) return '尝试次数未记录';
  return `${call.attempt > 1 ? '重试 · ' : ''}第 ${call.attempt}/${call.maxAttempts ?? '?'} 次尝试`;
}

/** 失败细节在运行中与结束后均可查看；缺失的历史字段不补造为 HTTP 200。 */
export function ModelCallDiagnostic({ call }: { call: ModelCallMetadata }) {
  const diagnostics = call.diagnostics;
  if (call.status !== 'ERROR') return null;
  return (
    <p className="muted wrap">
      {call.error ?? '未知错误'} ·{' '}
      {diagnostics ? REASONS[diagnostics.reason] : '历史诊断未记录'}
      {diagnostics && (
        <>
          {' · '}
          {PHASES[diagnostics.phase]}
          {' · '}
          {diagnostics.httpStatus === null
            ? '未收到 HTTP 状态'
            : `HTTP ${diagnostics.httpStatus}`}
          {' · 响应类型：'}
          {diagnostics.contentType ?? '未提供'}
          {' · 正文格式：'}
          {diagnostics.responseFormat}
          {diagnostics.responseBytes !== null &&
            ` · ${diagnostics.responseBytes} 字节`}
        </>
      )}
    </p>
  );
}

/** 单独轮询模型元数据，不影响画面与操作记录；切换执行时由资源 hook 中止旧请求。 */
export function ModelCallStatus({
  api,
  executionId,
  active,
  stepId,
}: {
  api: ApiClient;
  executionId: string;
  active: boolean;
  /** 实时页展示全部在途调用，回放只显示当前步骤；旧无归属记录放到其他操作。 */
  stepId?: string | undefined;
}) {
  const resource = useResource<{ calls: ModelCallMetadata[] }>(
    api,
    `/v1/admin/executions/${encodeURIComponent(executionId)}/model-calls`,
    active,
  );
  const calls = (resource.data?.calls ?? []).filter(
    (call) =>
      stepId === undefined ||
      (stepId === 'unassigned' ? !call.stepId : call.stepId === stepId),
  );
  const [now, setNow] = useState(Date.now);
  const waiting = active && calls.some((call) => call.status === 'PENDING');
  useEffect(() => {
    if (!waiting) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(timer);
  }, [waiting, executionId]);
  const latestError = calls.findLast((call) => call.status === 'ERROR');
  return (
    <section aria-label="模型请求" className="execution-model-calls">
      <h3>模型请求</h3>
      <ErrorNotice
        message={
          resource.error
            ? `模型记录同步失败，以下为上次读取结果：${resource.error}`
            : undefined
        }
      />
      {resource.error && (
        <Button
          variant="outline"
          onClick={resource.refresh}
          disabled={resource.loading}
        >
          重新读取模型记录
        </Button>
      )}
      {!resource.data && !resource.error && (
        <p className="muted">正在读取模型记录…</p>
      )}
      {resource.data && calls.length === 0 && (
        <p className="muted">暂无模型请求记录。</p>
      )}
      {calls
        .filter((call) => call.status === 'PENDING')
        .map((call) => (
          <p key={call.id} role="status">
            {active
              ? `等待模型回执 ${modelCallDuration(call, active, now)}`
              : '执行已结束，模型回执未确认'}
            {' · '}
            {attemptLabel(call)}
            {' · '}
            {call.stepId ?? '未关联步骤'}
            {call.timeoutMs !== undefined &&
              ` · 单次上限 ${call.timeoutMs / 1000} 秒`}
          </p>
        ))}
      {latestError && (
        <>
          <p>
            最近失败：请求 #{latestError.callIndex} ·{' '}
            {modelCallDuration(latestError, active, now)}
          </p>
          <ModelCallDiagnostic call={latestError} />
        </>
      )}
      {calls.length > 0 && (
        <details>
          <summary>查看 {calls.length} 次模型请求</summary>
          <ol>
            {calls.map((call) => (
              <li key={call.id}>
                <p>
                  #{call.callIndex} · {call.stepId ?? '未关联步骤'} ·{' '}
                  {call.model} · {attemptLabel(call)}
                  {' · '}
                  {call.status === 'ERROR'
                    ? '请求失败'
                    : call.status === 'RECEIVED'
                      ? '已收到响应'
                      : active
                        ? '等待回执'
                        : '回执未确认'}
                  {' · '}
                  {modelCallDuration(call, active, now)}
                  {' · '}
                  <time dateTime={call.startedAt}>
                    {new Date(call.startedAt).toLocaleTimeString()}
                  </time>
                </p>
                <ModelCallDiagnostic call={call} />
              </li>
            ))}
          </ol>
          <p className="muted">
            已收到响应不代表决定有效或验收通过；重试仍受步骤预算限制。
          </p>
        </details>
      )}
    </section>
  );
}
