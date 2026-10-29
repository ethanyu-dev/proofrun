/** 历史静态预检的缺口记录；仅供归档读取，新任务不再生成。 */
export interface VerificationCapabilityGap {
  /** 稳定能力身份与中文说明。 */
  capability: string;
  capabilityName: string;
  /** 无步骤任务使用 task。 */
  stepId: string;
  /** 原始要求，展示时必须按纯文本渲染。 */
  requirement: string;
  /** 归档当时记录的缺口原因。 */
  reason: string;
}
/** 历史静态评估的存储形状，不再参与新任务能力识别。 */
export interface VerificationCapabilityAssessment {
  /** 与归档绑定的能力目录版本。 */
  version: string;
  /** BLOCKED 表示能力覆盖不完整；是否整项停止由归档执行策略区分。 */
  status: 'SUPPORTED' | 'BLOCKED';
  /** 旧版按步骤跳过的策略标记；未记录此字段的归档保留整项阻塞语义。 */
  executionPolicy?: 'skip-steps';
  /** 缺口按步骤与能力去重，保留首个命中的原始要求。 */
  gaps: VerificationCapabilityGap[];
}
