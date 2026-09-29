/* 根据 contracts/schemas 自动生成，请勿手改；修改 Schema 后运行 pnpm contracts:generate。 */

/**
 * 管理员读取近期执行事实；不包含动作输入值或执行令牌。
 */
export interface ExecutionActivity {
  commands: {
    id: string;
    kind: string;
    actor: 'AGENT' | 'HUMAN';
    action: string | null;
    status: string | null;
    effect: string | null;
    error: string | null;
    created_at: string;
  }[];
  events: {
    mode: 'AUTO' | 'REQUESTED' | 'HUMAN';
    revision: number;
    reason: string | null;
    created_at: string;
  }[];
  observation: null | {
    observationId: string;
    url?: string;
    text: string;
    targets: {
      target: string;
      role: string;
      name: string;
    }[];
    [k: string]: unknown;
  };
  artifacts: {
    id: string;
    kind: 'DOM' | 'SCREENSHOT' | 'NETWORK';
    sha256: string;
  }[];
  limit: number;
}
