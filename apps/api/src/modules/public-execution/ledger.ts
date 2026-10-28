import type { PoolClient } from 'pg';
import { ApiError, canonical, digest } from '../../domain.js';
import type { Database } from '../../db.js';
import { validateMcpTaskResult } from '@proofrun/contracts';

/** 公共资源归属独立于执行状态；软删除不能使幂等键重新可用。 */
export interface ResourceRef {
  kind: 'run' | 'request';
  id: string;
}
/** 权限检查和业务写入共用事务连接，避免先鉴权后资源被换绑。 */
export type PublicQuery = Pick<Database, 'query'>;

/** 与原请求写入采用相同的锁名，覆盖来自旧 API 的并发成员替换。 */
export async function lockPublic(client: PoolClient, key: string) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    key,
  ]);
}
/** 不可见资源统一返回不存在；仅内部已知归属可执行后续业务读取。 */
export async function requireOwned(
  query: PublicQuery,
  principal: string,
  resource: ResourceRef,
) {
  const owned = await query.query(
    'SELECT 1 FROM pr_public_owners WHERE kind=$1 AND resource_id=$2 AND principal_id=$3',
    [resource.kind, resource.id, principal],
  );
  if (!owned.rowCount)
    throw new ApiError(404, 'RESOURCE_NOT_FOUND', '资源不存在或不可访问');
  const visible =
    resource.kind === 'run'
      ? await query.query(
          'SELECT 1 FROM pr_tasks WHERE id=$1 AND deleted_at IS NULL',
          [resource.id],
        )
      : await query.query(
          'SELECT 1 FROM pr_verification_requests WHERE request_id=$1 AND deleted_at IS NULL',
          [resource.id],
        );
  if (!visible.rowCount)
    throw new ApiError(410, 'RESOURCE_DELETED', '资源已删除，不能通过重试复活');
}
/** 新资源可绑定；已存在的旧 API 或其他调用方资源不能被新凭据认领。 */
export async function checkBinding(
  client: PoolClient,
  principal: string,
  resource: ResourceRef,
) {
  const existing =
    resource.kind === 'run'
      ? await client.query('SELECT 1 FROM pr_tasks WHERE id=$1', [resource.id])
      : await client.query(
          'SELECT 1 FROM pr_verification_requests WHERE request_id=$1',
          [resource.id],
        );
  if (existing.rowCount) {
    const owner = await client.query(
      'SELECT 1 FROM pr_public_owners WHERE kind=$1 AND resource_id=$2 AND principal_id=$3',
      [resource.kind, resource.id, principal],
    );
    if (!owner.rowCount)
      throw new ApiError(409, 'RESOURCE_CONFLICT', '身份不可用于此次提交');
    await requireOwned(client, principal, resource);
  }
}
/** 入队后同事务登记归属，任何冲突都使整个任务提交回滚。 */
export async function bindOwned(
  client: PoolClient,
  principal: string,
  resource: ResourceRef,
) {
  await client.query(
    'INSERT INTO pr_public_owners(kind,resource_id,principal_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
    [resource.kind, resource.id, principal],
  );
  await requireOwned(client, principal, resource);
}

/** 只在事务里运行数据库业务，返回值与入队事实一起持久化；不执行外部 HTTP。 */
export async function publicCall<T extends Record<string, unknown>>(
  db: Database,
  principal: string,
  namespace: string,
  key: string,
  input: unknown,
  execute: (
    client: PoolClient,
  ) => Promise<{ result: T; resources: ResourceRef[] }>,
): Promise<T> {
  return db.transaction(async (client) => {
    await lockPublic(
      client,
      `public:${canonical([principal, namespace, key])}`,
    );
    if (namespace === 'operation') {
      await lockPublic(client, `external-operation:${principal}:${key}`);
      if (
        (
          await client.query(
            'SELECT 1 FROM pr_external_operations WHERE principal_id=$1 AND id=$2',
            [principal, key],
          )
        ).rowCount
      )
        throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', '操作键已用于直接执行');
    }
    const hash = digest(canonical(input));
    const old = (
      await client.query(
        'SELECT input_hash,result,resources FROM pr_public_calls WHERE principal_id=$1 AND namespace=$2 AND call_key=$3',
        [principal, namespace, key],
      )
    ).rows[0];
    if (old) {
      if (old.input_hash !== hash)
        throw new ApiError(
          409,
          'IDEMPOTENCY_CONFLICT',
          '重试键已绑定另一份输入',
        );
      for (const resource of old.resources as ResourceRef[])
        await requireOwned(client, principal, resource);
      return old.result as T;
    }
    const value = await execute(client);
    // 契约错误不能在事务提交后才发现，防止入队成功却永久返回无效回执。
    if (!validateMcpTaskResult(value.result))
      throw new ApiError(
        503,
        'INVALID_PUBLIC_RESULT',
        '服务端结果不符合公共契约',
      );
    for (const resource of value.resources)
      await requireOwned(client, principal, resource);
    await client.query(
      'INSERT INTO pr_public_calls(principal_id,namespace,call_key,input_hash,result,resources) VALUES($1,$2,$3,$4,$5,$6)',
      [
        principal,
        namespace,
        key,
        hash,
        value.result,
        JSON.stringify(value.resources),
      ],
    );
    return value.result;
  });
}
