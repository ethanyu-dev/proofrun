import type { VerificationCapabilityAssessment } from '@proofrun/contracts/verification-capabilities';

/** 仅展示历史预检记录，不代表当前能力判断或执行策略；外部原文只作为文本。 */
export function CapabilityAssessment({
  assessment,
  title = '历史能力预检',
  compact = false,
}: {
  assessment: VerificationCapabilityAssessment;
  title?: string;
  /** 启动区按能力合并摘要；运行详情始终逐项展示原要求。 */
  compact?: boolean;
}) {
  const blocked = assessment.status === 'BLOCKED';
  const partial = assessment.executionPolicy === 'skip-steps';
  const groups = [...new Set(assessment.gaps.map((gap) => gap.capability))].map(
    (id) => assessment.gaps.filter((gap) => gap.capability === id),
  );
  return (
    <div className="bench-notice bench-capability" role="status">
      <strong>
        {title} ·{' '}
        {blocked
          ? partial
            ? '能力不足 · 按步骤跳过'
            : '缺少验证能力，未开始验证'
          : '未发现已知工具缺口'}
      </strong>
      {blocked && (
        <>
          <p>
            {partial
              ? '该历史运行按静态规则跳过以下步骤，其余步骤继续验证；该规则现已移除，新运行不再据此跳过。'
              : '该历史运行在预检时整项停止，未调用模型或创建浏览器会话；该规则现已移除。'}
          </p>
          <div className="bench-step-list">
            {compact
              ? groups.map((gaps) => (
                  <div key={gaps[0]!.capability}>
                    <strong>{gaps[0]!.capabilityName}</strong>
                    <span>
                      {gaps.map((gap) => gap.stepId).join('、')}：
                      {gaps[0]!.reason}
                    </span>
                  </div>
                ))
              : assessment.gaps.map((gap, index) => (
                  <div key={index}>
                    <strong>
                      {gap.stepId} · {gap.capabilityName}
                    </strong>
                    <div>
                      <span>{gap.reason}</span>
                      <p>
                        <strong>无法验证的要求：</strong>
                        {gap.requirement}
                      </p>
                    </div>
                  </div>
                ))}
          </div>
        </>
      )}
    </div>
  );
}
