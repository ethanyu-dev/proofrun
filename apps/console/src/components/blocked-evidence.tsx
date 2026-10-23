import { useState } from 'react';
import type { StepResult, TaskDetail } from '@proofrun/contracts';
import type { ApiClient } from '../api';
import { ReportEvidenceButton, ReportEvidenceDrawer } from './report-evidence';
import { ReportSummary } from './report-summary';

/** 显示冻结的具体原因及当时截图；旧报告只回退到同一步最后登记的截图。 */
export function BlockedEvidence({
  api,
  task,
  step,
}: {
  api: ApiClient;
  task: TaskDetail;
  step: StepResult;
}) {
  const [selected, setSelected] = useState<string>();
  const artifacts = task.report?.artifacts ?? [];
  const refs = step.blockage?.evidenceRefs ?? step.evidenceRefs;
  const screenshot = [...refs]
    .reverse()
    .map((id) =>
      artifacts.find((item) => item.id === id && item.kind === 'SCREENSHOT'),
    )
    .find(Boolean);
  const artifact = artifacts.find((item) => item.id === selected);
  return (
    <section aria-label="阻塞原因与截图" className="panel">
      <h3>{step.blockage ? '阻塞时截图' : '阻塞步骤最后记录的截图'}</h3>
      <p className="muted">
        {step.stepId} · 此处保留阻塞现场，清理截图在「后续清理」中单独展示。
      </p>
      <ReportSummary text={step.summary} />
      {step.blockage?.conditions.map((condition) => (
        <div key={condition.id} className="wrap">
          <strong>
            {condition.description} ·{' '}
            {condition.status === 'UNSATISFIED' ? '未满足' : '未确认'}
          </strong>
          <p>{condition.summary}</p>
        </div>
      ))}
      {!!step.environmentHistory?.length && (
        <details>
          <summary>环境处理历史（{step.environmentHistory.length} 次）</summary>
          {step.environmentHistory.map((entry, index) => (
            <div key={`${entry.recordedAt}-${index}`} className="wrap">
              <p>{entry.reason}</p>
              <p className="muted">
                {new Date(entry.recordedAt).toLocaleString('zh-CN')} · 认证版本{' '}
                {entry.authRevision} · 控制版本 {entry.controlRevision}
              </p>
              {entry.conditions.map((condition) => (
                <p key={condition.id}>
                  {condition.description}：{condition.summary}
                </p>
              ))}
            </div>
          ))}
        </details>
      )}
      {step.blockage && (
        <p className="muted">
          阻塞记录时间：
          {new Date(step.blockage.recordedAt).toLocaleString('zh-CN')}
        </p>
      )}
      {screenshot ? (
        <ReportEvidenceButton
          api={api}
          artifact={screenshot}
          archived={!!task.archived_at}
          onSelect={() => setSelected(screenshot.id)}
        />
      ) : (
        <p className="muted">
          未取得可展示的阻塞截图
          {step.blockage?.screenshotError
            ? `（${step.blockage.screenshotError}）`
            : '，不会使用清理截图替代'}
          。
        </p>
      )}
      {artifact && (
        <ReportEvidenceDrawer
          api={api}
          artifact={artifact}
          context={`${step.stepId} · 阻塞现场`}
          close={() => setSelected(undefined)}
        />
      )}
    </section>
  );
}
