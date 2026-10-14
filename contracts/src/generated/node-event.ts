/* 根据 contracts/schemas 自动生成，请勿手改；修改 Schema 后运行 pnpm contracts:generate。 */

/**
 * Browser Node 发往控制面的心跳、执行结果及可靠交付事件。
 */
export type NodeEvent =
  | {
      type: 'command.result';
      protocolVersion: '0.1';
      messageId: string;
      commandId: string;
      sessionId: string;
      nodeId: string;
      nodeEpoch: string;
      leaseId: string;
      fence: number;
      /**
       * 浏览器命令的执行状态；不代表验收项结论。
       */
      operationStatus: 'SUCCEEDED' | 'FAILED' | 'UNKNOWN' | 'CANCELLED' | 'TIMED_OUT';
      /**
       * 命令对页面或业务系统产生效果的确定程度；MAY_HAVE_HAPPENED 不可盲目重试。
       */
      effect: 'NOT_STARTED' | 'COMPLETED' | 'MAY_HAVE_HAPPENED';
      data?: {
        [k: string]: unknown;
      };
      error?: {
        code: string;
        message: string;
      };
    }
  | {
      type: 'command.pending';
      protocolVersion: '0.1';
      messageId: string;
      commandId: string;
      sessionId: string;
      nodeId: string;
      nodeEpoch: string;
      leaseId: string;
      fence: number;
    }
  | {
      type: 'node.heartbeat';
      protocolVersion: '0.1';
      nodeId: string;
      nodeEpoch: string;
      /**
       * 租约授权必须回带此 ID；租约时长从本心跳发出时计起。
       */
      leaseRequestId: string;
      pool: string;
      capacity: number;
      /**
       * 本机仍占用容量的会话，包括关闭中和隔离状态。
       */
      occupied: {
        sessionId: string;
        state: string;
        leaseId: string;
        fence: number;
      }[];
      capabilities: {
        observe: boolean;
        screenshot: boolean;
        conditionWait: boolean;
        /**
         * 节点是否允许写动作；开发开关打开也不表示引擎写入语义已验证。
         */
        writeActions: boolean;
        /**
         * 引擎在业务成功但响应丢失时的重试行为是否完成验证。
         */
        engineWritesVerified: boolean;
        networkEvidence: boolean;
        /**
         * 支持任务绑定的节点本地登录状态复用。
         */
        authState?: boolean;
        liveView?: boolean;
        /**
         * 支持 Chromium trace 的采集、可靠上传和下载。
         */
        trace?: boolean;
        /**
         * 支持人工等待暂停时限的可续期会话。
         */
        renewableSessions?: boolean;
        /**
         * 支持引用节点私有身份库并在独立准备阶段核验登录。
         */
        identityPreparation?: boolean;
        /**
         * 支持仅删除指定站点指定名字的 Cookie 并回读验证
         */
        cookieCleanup?: boolean;
        /**
         * 支持分组标签页及每页独立观察引用。
         */
        profileTabs?: boolean;
        environmentProof?: boolean;
        fullProfile?: boolean;
      };
      /**
       * 节点接受的租约和会话硬期限上限，控制面不得超额授权。
       */
      limits: {
        maxLeaseMs: number;
        maxSessionMs: number;
      };
      runtime?: NodeRuntime;
    }
  | {
      type: 'protocol.error';
      code: string;
    }
  | {
      type: 'artifact.available';
      messageId: string;
      artifactId: string;
      sha256: string;
    }
  | {
      type: 'session.closed';
      messageId: string;
      sessionId: string;
      nodeEpoch: string;
      leaseId: string;
      fence: number;
      state: 'CLOSED' | 'QUARANTINED';
      /**
       * 只有 true 才表示进程资源已确认回收，容量可以释放。
       */
      closureVerified: boolean;
      /**
       * 节点保存的首个关闭触发原因；旧节点可省略，不从关闭结果倒推原因。
       */
      closeReason?:
        | 'SESSION_CLOSE_REQUESTED'
        | 'NODE_SHUTDOWN'
        | 'NODE_RESTART_RECOVERY'
        | 'SESSION_LEASE_EXPIRED'
        | 'SESSION_START_FAILED'
        | 'HOST_EXITED'
        | 'HOST_CHANNEL_CLOSED'
        | 'SESSION_OPERATION_FAILED'
        | 'SESSION_COMMAND_TIMEOUT'
        | 'UNKNOWN';
    };

/**
 * 节点进程上报的编译身份；用于排查部署版本，不作为授权或能力判断依据。
 */
export interface NodeRuntime {
  /**
   * 完整 release 标签；开发构建带 dev 后缀，不冒充正式安装版本。
   */
  version: string;
  /**
   * 发布源码的完整提交 SHA；本地未注入时为 null。
   */
  sourceCommit: string | null;
  /**
   * 节点启动时核实的 agent-browser 固定版本。
   */
  engineVersion: string;
}
