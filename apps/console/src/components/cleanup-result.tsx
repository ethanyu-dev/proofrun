import { useState } from 'react';
import type { CaseStep, StepResult, TaskDetail } from '@proofrun/contracts';
import type { ApiClient } from '../api';
import { ReportEvidenceButton, ReportEvidenceDrawer } from './report-evidence';
import { ReportSummary } from './report-summary';

/** 清理执行结束不等于效果已核实；只按明确验收项和已登记证据展示确认结果。 */
export function CleanupResult({
  api,
  task,
  step,
  result,
  status,
}: {
  api: ApiClient;
  task: TaskDetail;
  step: CaseStep;
  result: StepResult | undefined;
  status: StepResult['status'];
}) {
  const [selected, setSelected] = useState<string>();
  const definitions = task.definition.acceptanceCriteria.filter(
    (item) => item.stepId === step.stepId,
  );
  const criteria = definitions.map((definition) => ({
    definition,
    result: (result?.criteria.length
      ? result.criteria
      : task.report?.criteria
    )?.find((item) => item.criterionId === definition.id),
  }));
  const artifacts = task.report?.artifacts ?? [];
  const failed = criteria.some((item) => item.result?.verdict === 'FAILED');
  // 不使用空数组的 every 结果确认旧清理步骤，也不把任意步骤截图当成全部清理目标的证明。
  const confirmed =
    status === 'COMPLETED' &&
    step.expected.length > 0 &&
    criteria.length === step.expected.length &&
    criteria.every(
      ({ definition, result }) =>
        result?.verdict === 'PASSED' &&
        result.evidenceRefs.length > 0 &&
        result.evidenceRefs.every((id) => artifacts.some((a) => a.id === id)) &&
        definition.evidenceKinds.every((kind) =>
          result.evidenceRefs.some((id) =>
            artifacts.some((a) => a.id === id && a.kind === kind),
          ),
        ),
    );
  const label =
    failed || status === 'ERROR' ? '失败' : confirmed ? '已确认' : '未确认';
  const reason = failed
    ? '清理验收项未通过。'
    : status === 'ERROR'
      ? '清理执行异常，未能确认清理目标已全部完成。'
      : confirmed
        ? '已配置的清理验收项全部通过，均有关联证据。'
        : status === 'COMPLETED'
          ? '执行已完成，但缺少完整的清理验收项或证据，不能确认清理目标已全部满足。'
          : status === 'BLOCKED'
            ? '清理受阻，尚未确认清理效果。'
            : status === 'RUNNING'
              ? '清理执行中，尚未确认清理效果。'
              : '清理尚未执行，尚未确认清理效果。';
  const refs = [
    ...new Set([
      ...(result?.evidenceRefs ?? []),
      ...criteria.flatMap((item) => item.result?.evidenceRefs ?? []),
    ]),
  ];
  const artifact = artifacts.find((item) => item.id === selected);
  return (
    <div aria-label={`清理结果：${step.stepId}`}>
      <strong>清理结果：{label}</strong>
      <p className="muted wrap">{reason}</p>
      <details>
        <summary>清理记录与证据（{refs.length}）</summary>
        {result && <ReportSummary text={result.summary} />}
        {criteria.map(({ definition, result }) => (
          <div key={definition.id}>
            <p className="wrap">清理目标：{definition.expectedResult}</p>
            {result && <ReportSummary text={result.summary} />}
          </div>
        ))}
        {refs.map((ref) => {
          const evidence = artifacts.find((item) => item.id === ref);
          return evidence ? (
            <ReportEvidenceButton
              key={ref}
              api={api}
              artifact={evidence}
              archived={!!task.archived_at}
              onSelect={() => setSelected(ref)}
            />
          ) : (
            <p className="muted wrap" key={ref}>
              证据 {ref} 尚未收录到报告，暂不可预览。
            </p>
          );
        })}
        {!refs.length && <p className="muted">未关联清理证据。</p>}
      </details>
      {artifact && (
        <ReportEvidenceDrawer
          api={api}
          artifact={artifact}
          context={`${step.stepId} · ${step.description}`}
          close={() => setSelected(undefined)}
        />
      )}
    </div>
  );
}
