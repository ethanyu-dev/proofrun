import { useEffect, useRef, useState } from 'react';
import type { TaskDetail, VerificationReport } from '@proofrun/contracts';
import { ErrorNotice } from './ui';
import { executionModeLabel } from '../execution-mode';

/** 导出呈现原报告与统一状态，浏览器不能下载时仍可读取和复制给上层 Agent。 */
export function ReportExport({
  report,
  assessment,
  close,
}: {
  report: VerificationReport;
  /** 导出保留存档原文，并附上与 API 一致的状态和覆盖统计。 */
  assessment: Pick<
    TaskDetail,
    'reportStatus' | 'criteriaCounts' | 'definition'
  >;
  close: () => void;
}) {
  const json = JSON.stringify(
    {
      ...report,
      executionMode: assessment.definition.executionMode ?? 'llm',
      executionModeLabel: executionModeLabel(
        assessment.definition.executionMode,
      ),
      reportStatus: assessment.reportStatus,
      criteriaCounts: assessment.criteriaCounts,
    },
    null,
    2,
  );
  const [url, setUrl] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string>();
  const section = useRef<HTMLElement>(null);
  useEffect(() => {
    section.current?.focus();
  }, []);
  useEffect(() => {
    const value = URL.createObjectURL(
      new Blob([json], { type: 'application/json' }),
    );
    setUrl(value);
    return () => URL.revokeObjectURL(value);
  }, [json]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      setError(undefined);
    } catch {
      setError('复制失败，可在下方文本框中手动选择并复制。');
    }
  };
  return (
    <section
      className="panel"
      ref={section}
      tabIndex={-1}
      aria-label="导出报告"
    >
      <div className="section-heading">
        <h2>报告 JSON</h2>
        <button className="button button-secondary" onClick={close}>
          关闭导出
        </button>
      </div>
      <textarea
        aria-label="导出的报告 JSON"
        className="mono"
        readOnly
        rows={12}
        value={json}
      />
      <ErrorNotice message={error} />
      <div className="form-footer">
        <p className="muted">
          可将此报告直接交给上层 Agent。证据下载仍需访问凭据。
        </p>
        <div className="page-actions">
          <button
            className="button button-secondary"
            onClick={() => void copy()}
          >
            {copied ? '已复制报告' : '复制报告 JSON'}
          </button>
          {url && (
            <a
              className="button button-primary"
              href={url}
              download={`${report.taskId}-report.json`}
            >
              下载 JSON
            </a>
          )}
        </div>
      </div>
    </section>
  );
}
