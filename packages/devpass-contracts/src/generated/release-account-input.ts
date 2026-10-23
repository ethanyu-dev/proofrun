/** 从 JSON Schema 自动生成；请修改契约源文件后重新生成。 */

export interface ReleaseAccountInput {
  /**
   * 本次使用的租约 ID，不是账号 ID。
   */
  lease_id: string;
  /**
   * 由可信执行环境确认资源停止，不能以任务完成代替。
   */
  usage_stopped: boolean;
  outcome:
    | 'completed'
    | 'cancelled'
    | 'credential_invalid'
    | 'identity_mismatch'
    | 'account_state_changed'
    | 'execution_error';
  note?: string;
}
