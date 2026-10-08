/* 根据 contracts/schemas 自动生成，请勿手改；修改 Schema 后运行 pnpm contracts:generate。 */

/**
 * 管理员节点视图，不包含机器凭据和凭据摘要。
 */
export interface NodeList {
  nodes: NodeSummary[];
}
/**
 * 容量占用取节点上报与控制面未确认关闭会话的并集。
 */
export interface NodeSummary {
  id: string;
  name: string;
  pool: string;
  node_epoch: string | null;
  capacity: number;
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
}
