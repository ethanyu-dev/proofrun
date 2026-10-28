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
      /**
       * 任务目标地址，Cookie 写入仅允许该 origin。
       */
      targetUrl?: string;
      /**
       * @maxItems 10
       */
      conditionKeys?:
        | []
        | [string]
        | [string, string]
        | [string, string, string]
        | [string, string, string, string]
        | [string, string, string, string, string]
        | [string, string, string, string, string, string]
        | [string, string, string, string, string, string, string]
        | [string, string, string, string, string, string, string, string]
        | [string, string, string, string, string, string, string, string, string]
        | [string, string, string, string, string, string, string, string, string, string];
      /**
       * 节点已冻结输入，等待控制面确认完成。
       */
      finalizing?: boolean;
      /**
       * 实际人工处理截止时间；链接有效不代表任务仍可处理。
       */
      waitDeadline?: string;
      /**
       * 当前会话已启用运行时取证。
       */
      runtimeEvidenceAvailable?: boolean;
      /**
       * 管理员维护节点模板，完成后发布并关闭，不恢复自动任务。
       */
      profileMaintenance?: boolean;
    }
  | {
      type: 'frame';
      data: string;
      width: number;
      height: number;
      capturedAt?: number;
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
      /**
       * 仅只读观察的脱敏运行时证据；输入命令不回传账号材料。
       */
      evidence?: {
        runtime?: {
          [k: string]: unknown;
        };
        network?: {
          [k: string]: unknown;
        };
      };
    }
  | {
      type: 'completed';
      /**
       * 已保存、保留其他会话更新的快照、或未启用登录复用。
       */
      authStatus?: 'saved' | 'newer' | 'disabled';
      /**
       * 模板维护结果，保存和物理关闭已由控制面核实。
       */
      profileMaintenance?: boolean;
    }
  | {
      type: 'unable';
      reason: string;
      /**
       * 模板维护结果，保存和物理关闭已由控制面核实。
       */
      profileMaintenance?: boolean;
    };
