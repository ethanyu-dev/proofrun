import { domainToASCII } from 'node:url';
import type { PoolClient } from 'pg';
import type { NodeRoutingWrite } from '@proofrun/contracts';
import type { Database } from '../../db.js';
import { ApiError } from '../../domain.js';

/** 配置修改与会话分配互斥，保存完成后新的领取必须看到新规则。 */
const ROUTING_LOCK = 'proofrun-node-routing-v1';
/** 只接受完整主机名标签；不把通配符、URL、端口或路径误存为域名。 */
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** 任务与配置共用 URL 主机名语义，忽略大小写、端口和末尾根域点。 */
export function targetHostname(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return '';
  }
}

/** 国际化域名保存为 ASCII；限制输入为单个完整域名，拒绝隐式 URL 解析修正。 */
export function normalizeDomain(input: string): string {
  const raw = input.trim();
  const ascii = domainToASCII(raw).toLowerCase().replace(/\.$/, '');
  if (
    /[\s/:@?#%\\]/u.test(raw) ||
    !ascii ||
    ascii.length > 253 ||
    !ascii.split('.').every((label) => HOST_LABEL.test(label))
  )
    throw new ApiError(
      400,
      'INVALID_DOMAIN',
      '请填写完整域名，不含协议、端口、路径或通配符',
    );
  const hostname = targetHostname(`http://${ascii}`);
  if (!hostname) throw new ApiError(400, 'INVALID_DOMAIN', '域名格式无效');
  return hostname;
}

/** 快照键包含资源池，避免不同业务网络的相同域名互相影响。 */
export function routeKey(pool: string, hostname: string): string {
  return JSON.stringify([pool, hostname]);
}

/** 领取事务一直持有共享锁，规则不能在节点选择与会话登记之间变化。 */
export async function routingSnapshot(
  client: PoolClient,
): Promise<Map<string, string>> {
  await client.query(
    'SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',
    [ROUTING_LOCK],
  );
  const rows = await client.query<{
    pool: string;
    hostname: string;
    node_id: string;
  }>('SELECT pool,hostname,node_id FROM pr_node_routes');
  return new Map(
    rows.rows.map((row) => [routeKey(row.pool, row.hostname), row.node_id]),
  );
}

/** 节点模块持久化域名配置；所有写入作为一次原子替换提交。 */
export class NodeRouting {
  constructor(private readonly db: Database) {}

  /** 空列表解除该节点全部绑定；过期编辑和池内重复绑定均不覆盖原配置。 */
  async save(nodeId: string, input: NodeRoutingWrite) {
    const domains = [...new Set(input.domains.map(normalizeDomain))].sort();
    return this.db.transaction(async (client) => {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [ROUTING_LOCK],
      );
      const node = (
        await client.query<{
          pool: string;
          revoked_at: unknown;
          routing_revision: number;
        }>(
          'SELECT pool,revoked_at,routing_revision FROM pr_nodes WHERE id=$1 FOR NO KEY UPDATE',
          [nodeId],
        )
      ).rows[0];
      if (!node) throw new ApiError(404, 'NODE_MISSING', '节点不存在');
      if (node.routing_revision !== input.revision)
        throw new ApiError(
          409,
          'ROUTING_CHANGED',
          '域名配置已被修改，请关闭编辑并刷新后重试',
        );
      if (node.revoked_at && domains.length)
        throw new ApiError(409, 'NODE_REVOKED', '已撤销节点只能清空域名绑定');
      const conflict = await client.query(
        'SELECT hostname FROM pr_node_routes WHERE pool=$1 AND hostname=ANY($2::text[]) AND node_id<>$3 LIMIT 1',
        [node.pool, domains, nodeId],
      );
      if (conflict.rowCount)
        throw new ApiError(
          409,
          'DOMAIN_ASSIGNED',
          `域名 ${conflict.rows[0].hostname} 已绑定到同池其他节点，请先解除原绑定`,
        );
      await client.query('DELETE FROM pr_node_routes WHERE node_id=$1', [
        nodeId,
      ]);
      await client.query(
        'INSERT INTO pr_node_routes(pool,hostname,node_id) SELECT $1,hostname,$2 FROM unnest($3::text[]) AS hostname',
        [node.pool, nodeId, domains],
      );
      await client.query(
        'UPDATE pr_nodes SET routing_revision=routing_revision+1 WHERE id=$1',
        [nodeId],
      );
      return { domains, revision: node.routing_revision + 1 };
    });
  }
}
