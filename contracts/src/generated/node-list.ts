/* 根据 contracts/schemas 自动生成，请勿手改；修改 Schema 后运行 pnpm contracts:generate。 */

/**
 * 管理员节点视图，不包含机器凭据和凭据摘要。
 */
export interface NodeList {
  nodes: NodeSummary[];
}
/**
 * 会话占用取节点上报与控制面未确认关闭会话的并集，仅供展示；资源准入由节点决定。
 */
export interface NodeSummary {
  id: string;
  name: string;
  pool: string;
  node_epoch: string | null;
  capabilities: {
    [k: string]: unknown;
  };
  inventory: {
    [k: string]: unknown;
  }[];
  last_seen_at: string | null;
  revoked_at: string | null;
  online: boolean;
  occupied: number;
  /**
   * 当前节点在其资源池内绑定的完整域名或 *.example.com 通配符规则。
   */
  routing_domains: string[];
  /**
   * 域名配置编辑版本。
   */
  routing_revision: number;
  /**
   * 最近心跳上报的进程版本；未上报时为 null，离线节点仅代表最后一次上报。
   */
  runtime?: NodeRuntime | null;
  public_url?: string | null;
  admission?: {
    accepting?: boolean;
    reason?: string;
    cpuPercent?: number;
    availableBytes?: number;
    reserveBytes?: number;
    [k: string]: unknown;
  } | null;
  /**
   * 节点已发布的默认模板元数据；不包含登录材料。空值表示尚未初始化。
   */
  default_profile?: {
    version: string;
    updatedAt: string;
    sessionId: string;
  } | null;
}
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
