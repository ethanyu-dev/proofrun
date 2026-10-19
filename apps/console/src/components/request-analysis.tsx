import { useEffect, useRef, useState } from 'react';
import type {
  RequestAnalysis as Analysis,
  RequestResultV2,
} from '@proofrun/contracts';
import { ApiClient, errorMessage } from '../api';
import { useResource } from '../use-resource';
import { ErrorNotice, time } from './ui';
import { ReportSummary } from './report-summary';

/** 独立轮询不阻塞报告展示，首次自动生成幂等；失败后由用户显式重跑。 */
export function RequestAnalysis({
  api,
  value,
}: {
  api: ApiClient;
  value: RequestResultV2;
}) {
  const path = `/v2/requests/${encodeURIComponent(value.requestId)}/analysis`;
  const resource = useResource<Analysis | null>(api, path);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const autoRequested = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const finished = value.executionStatus === 'FINISHED';
  const analysis = resource.data;
  const running =
    analysis?.status === 'QUEUED' || analysis?.status === 'RUNNING';

  /** 页面卸载后忽略响应；服务端仍可继续已入队的分析。 */
  useEffect(() => () => controller.current?.abort(), []);

  async function generate(rerun: boolean) {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setBusy(true);
    setError(undefined);
    try {
      await api.json(path, current.signal, { rerun });
      if (!current.signal.aborted) resource.refresh();
    } catch (reason) {
      if (!current.signal.aborted) setError(errorMessage(reason));
    } finally {
      if (!current.signal.aborted) setBusy(false);
    }
  }

  useEffect(() => {
    if (finished && analysis === null && !autoRequested.current) {
      autoRequested.current = true;
      void generate(false);
    }
  }, [finished, analysis]);

  return (
    <section
      className="panel request-agent-analysis"
      aria-label="Agent 分析"
      aria-busy={busy || running}
    >
      <div className="request-report-heading">
        <h2>Agent 分析</h2>
        <button
          className="button button-secondary button-small"
          disabled={!finished || busy || running || resource.data === undefined}
          onClick={() => void generate(!!analysis)}
        >
          {busy || running ? '正在生成…' : analysis ? '重新分析' : '生成分析'}
        </button>
      </div>
      <p className="muted">
        结合本次执行步骤与实际观察，总结失败 Case 及原因。
      </p>
      <ErrorNotice
        message={error ?? resource.error ?? analysis?.error ?? undefined}
      />
      {analysis?.summary ? (
        <>
          <ReportSummary text={analysis.summary} />
          <p className="muted">
            {analysis.status !== 'SUCCEEDED' ? '上一版分析 · ' : ''}
            {time(analysis.generatedAt)}
            {analysis.model && ` · ${analysis.model}`}
          </p>
        </>
      ) : (
        <p role="status">
          {!finished
            ? '验证结束后自动生成分析。'
            : analysis?.status === 'QUEUED'
              ? '等待 Agent 生成分析，可继续查看 Case 验证结果。'
              : running || busy
                ? 'Agent 正在复盘执行步骤与观察记录…'
                : analysis?.status === 'FAILED'
                  ? '本次分析未完成，可以重新分析。'
                  : resource.loading
                    ? '正在读取分析…'
                    : '尚未生成分析。'}
        </p>
      )}
      {running && analysis?.summary && (
        <p role="status">正在重新分析，完成后更新结论。</p>
      )}
    </section>
  );
}
