/* 根据 contracts/schemas 自动生成，请勿手改；修改 Schema 后运行 pnpm contracts:generate。 */

export type HitlServer =
  | {
      type: 'state';
      taskId: string;
      reason: string;
      items: string[];
      mode: 'REQUESTED' | 'HUMAN';
      expiresAt: string;
      canSaveAuth: boolean;
    }
  | {
      type: 'frame';
      data: string;
      width: number;
      height: number;
    }
  | {
      type: 'error';
      code: string;
      message: string;
    }
  | {
      type: 'result';
      commandId: string;
      status: string;
      effect: string;
    }
  | {
      type: 'completed';
      /**
       * 已保存、保留其他会话更新的快照、或未启用登录复用。
       */
      authStatus?: 'saved' | 'newer' | 'disabled';
    };
