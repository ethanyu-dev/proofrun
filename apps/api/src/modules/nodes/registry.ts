import { createHmac } from 'node:crypto';
import type { ApiConfig } from '../../config.js';
import { Database } from '../../db.js';
import { ApiError, digest, newToken } from '../../domain.js';

/** 配对码只在十分钟内有效，成功使用一次即失效。 */
const PAIRING_TTL_MS = 10 * 60_000;

/** 管理注册身份和机器凭据；在线状态由连接管理器提供。 */
export class NodeRegistry {
  constructor(
    private readonly db: Database,
    private readonly config: ApiConfig,
  ) {}

  /** 管理员为指定内网资源池签发一次性注册许可。 */
  async enroll(pool: string, name: string) {
    const pairingToken = newToken();
    const expiresAt = new Date(Date.now() + PAIRING_TTL_MS);
    await this.db.query(
      'INSERT INTO pr_pairings(token_hash,pool,name,expires_at) VALUES($1,$2,$3,$4)',
      [digest(pairingToken), pool, name, expiresAt],
    );
    return { pairingToken, expiresAt, pool };
  }

  /** 绑定本机安装身份；新配对码不能静默覆盖已注册节点的凭据。 */
  async pair(nodeId: string, pool: string, pairingToken: string) {
    // 凭据可由原配对请求确定性恢复，数据库仍只保存摘要。
    const token = createHmac('sha256', this.config.adminToken)
      .update(JSON.stringify(['proofrun-node', nodeId, pairingToken]))
      .digest('base64url');
    await this.db.transaction(async (client) => {
      const result = await client.query(
        'SELECT * FROM pr_pairings WHERE token_hash=$1 AND expires_at>clock_timestamp() FOR UPDATE',
        [digest(pairingToken)],
      );
      const pairing = result.rows[0];
      if (!pairing || pairing.pool !== pool)
        throw new ApiError(
          401,
          'INVALID_PAIRING',
          'Pairing token expired, used, or assigned to another pool',
        );
      if (pairing.used_at) {
        const owned = await client.query(
          'SELECT 1 FROM pr_nodes WHERE id=$1 AND credential_hash=$2 AND revoked_at IS NULL',
          [nodeId, digest(token)],
        );
        if (pairing.paired_node_id !== nodeId || !owned.rowCount)
          throw new ApiError(
            401,
            'INVALID_PAIRING',
            'Pairing belongs to another credential',
          );
        return;
      }
      if (pairing.rotate_node_id) {
        if (pairing.rotate_node_id !== nodeId)
          throw new ApiError(
            401,
            'INVALID_PAIRING',
            'Rotation belongs to another node',
          );
        const node = await client.query(
          'SELECT id FROM pr_nodes WHERE id=$1 AND revoked_at IS NULL FOR NO KEY UPDATE',
          [nodeId],
        );
        if (
          !node.rowCount ||
          (
            await client.query(
              'SELECT 1 FROM pr_sessions WHERE node_id=$1 AND NOT closure_verified',
              [nodeId],
            )
          ).rowCount
        )
          throw new ApiError(
            409,
            'NODE_BUSY',
            'Rotation requires a non-revoked node with no unclosed sessions',
          );
        await client.query(
          'UPDATE pr_nodes SET credential_hash=$2 WHERE id=$1',
          [nodeId, digest(token)],
        );
      } else {
        if (
          (await client.query('SELECT 1 FROM pr_nodes WHERE id=$1', [nodeId]))
            .rowCount
        )
          throw new ApiError(
            409,
            'NODE_REGISTERED',
            'Node identity already registered',
          );
        await client.query(
          'INSERT INTO pr_nodes(id,pool,name,credential_hash) VALUES($1,$2,$3,$4)',
          [nodeId, pool, pairing.name, digest(token)],
        );
      }
      await client.query(
        'UPDATE pr_pairings SET used_at=clock_timestamp(),paired_node_id=$2 WHERE token_hash=$1',
        [digest(pairingToken), nodeId],
      );
    });
    return {
      nodeId,
      token,
      pool,
      protocolVersion: '0.1',
      gatewayUrl: `${this.config.publicUrl.replace(/^http/, 'ws')}/v1/nodes/connect`,
      artifactUploadUrl: `${this.config.publicUrl}/v1/artifacts`,
    };
  }

  /** 轮换许可有效期间暂停该节点的新调度；现有会话必须先确认关闭。 */
  async rotate(id: string) {
    const pairingToken = newToken();
    const expiresAt = new Date(Date.now() + PAIRING_TTL_MS);
    const pool = await this.db.transaction(async (client) => {
      const node = (
        await client.query(
          'SELECT pool,name FROM pr_nodes WHERE id=$1 AND revoked_at IS NULL FOR NO KEY UPDATE',
          [id],
        )
      ).rows[0];
      if (!node)
        throw new ApiError(404, 'NODE_MISSING', 'Active node not found');
      if (
        (
          await client.query(
            'SELECT 1 FROM pr_sessions WHERE node_id=$1 AND NOT closure_verified',
            [id],
          )
        ).rowCount
      )
        throw new ApiError(
          409,
          'NODE_BUSY',
          'Wait for browser cleanup before rotating',
        );
      await client.query(
        'DELETE FROM pr_pairings WHERE rotate_node_id=$1 AND used_at IS NULL',
        [id],
      );
      await client.query(
        'INSERT INTO pr_pairings(token_hash,pool,name,expires_at,rotate_node_id) VALUES($1,$2,$3,$4,$5)',
        [digest(pairingToken), node.pool, node.name, expiresAt, id],
      );
      return node.pool as string;
    });
    return { pairingToken, expiresAt, pool, nodeId: id };
  }

  /** 机器凭据只允许访问自己的连接和证据上传，不能代替管理员或 worker。 */
  async authenticate(token: string): Promise<{ id: string; hash: string }> {
    const hash = digest(token);
    const result = await this.db.query(
      'SELECT id FROM pr_nodes WHERE credential_hash=$1 AND revoked_at IS NULL',
      [hash],
    );
    if (!result.rows[0])
      throw new ApiError(
        401,
        'UNAUTHORIZED',
        'Unknown or revoked node credential',
      );
    return { id: result.rows[0].id as string, hash };
  }

  /** 不返回凭据摘要；在线和可分配容量由调用方结合当前连接判断。 */
  async list() {
    return (
      await this.db.query(
        `SELECT n.id,name,pool,node_epoch,capacity,capabilities,inventory,last_seen_at,revoked_at,routing_revision,
          ARRAY(SELECT hostname FROM pr_node_routes WHERE node_id=n.id ORDER BY hostname) AS routing_domains,
          (SELECT count(*)::integer FROM (
            SELECT item->>'sessionId' AS id FROM jsonb_array_elements(n.inventory) item
            UNION SELECT s.id FROM pr_sessions s WHERE s.node_id=n.id AND NOT s.closure_verified
          ) occupied_sessions) AS occupied
         FROM pr_nodes n ORDER BY created_at`,
      )
    ).rows;
  }
}
