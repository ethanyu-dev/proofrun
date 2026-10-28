import type { VerificationReport, RuntimeRequest } from '@proofrun/contracts';

/** 持久决定使用服务器墙钟期限，不能跨进程传 performance.now()。 */
export interface RuntimeDecisionFrame {
  /** 单次决定的幂等身份与冻结版本；并行组各自拥有帧。 */
  id: string;
  /** 服务器分配的单调版本，也是并行帧读取游标。 */
  revision: number;
  /** 与旧 runner 相同的七模块裁剪快照，不包含凭据。 */
  text: string;
  /** 本轮模型截止墙钟；空值表示沿用请求时限。 */
  modelDeadlineAt: string | null;
  /** 图片通过执行证据端口读取，JSON 不重复携带附件正文。 */
  imageArtifact?: { id: string; sha256: string };
}
/** 只读轮询不续租，最多返回一帧；调用者按 revision 继续读取并行组。 */
export interface RuntimeView {
  /** FINISHED 交付驱动报告，LOST 仅保留诊断事实。 */
  state: 'ACTIVE' | 'FINISHED' | 'LOST';
  /** 仍可提交的帧，不重放已接受决定。 */
  decisions: RuntimeDecisionFrame[];
  /** LOST 时可能只有部分报告，不能当作完整验证完成。 */
  report: VerificationReport | null;
}
export type RuntimeConfig = Extract<
  RuntimeRequest,
  { type: 'start' }
>['config'];
