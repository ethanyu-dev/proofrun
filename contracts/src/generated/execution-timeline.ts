/* 根据 contracts/schemas 自动生成，请勿手改；修改 Schema 后运行 pnpm contracts:generate。 */

/**
 * 分页读取完整浏览器操作及截图身份，不包含输入值、凭据或模型正文。
 */
export interface ExecutionTimeline {
  commands: {
    id: string;
    kind: string;
    actor: 'AGENT' | 'HUMAN';
    action: string | null;
    status: string | null;
    effect: string | null;
    error: string | null;
    created_at: string;
    screenshots: {
      id: string;
      sha256: string;
      state: string;
    }[];
    /**
     * 并行浏览器分组身份，用于区分同时执行的步骤。
     */
    tabScope: string | null;
  }[];
  nextCursor: string | null;
}
