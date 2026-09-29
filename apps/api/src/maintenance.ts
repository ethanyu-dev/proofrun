import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Database } from './db.js';
import { loadConfig } from './config.js';
import { ID_PATTERN } from './domain.js';

/** 每次只处理一批，避免维护事务无界增长。 */
const RETENTION_BATCH = 100;
/** 孤立文件至少保留一天，避免将近期未完成上传误当垃圾。 */
const ORPHAN_GRACE_MS = 86_400_000;

/** 仅清理已终态且浏览器确认关闭的执行；保留身份和去重摘要以阻止旧任务重放。 */
export async function retain(
  db: Database,
  directory: string,
  days: number,
  apply: boolean,
) {
  if (!Number.isSafeInteger(days) || days < 1 || days > 3650)
    throw new Error('Retention days must be between 1 and 3650');
  const tasks = await db.query<{ id: string }>(
    `SELECT t.id FROM pr_tasks t WHERE t.finished_at < clock_timestamp()-$1*interval '1 day' AND t.archived_at IS NULL AND t.state NOT IN ('QUEUED','RUNNING') AND NOT EXISTS (SELECT 1 FROM pr_executions e JOIN pr_sessions s ON s.execution_id=e.id WHERE e.task_id=t.id AND NOT s.closure_verified) ORDER BY t.finished_at LIMIT $2`,
    [days, RETENTION_BATCH],
  );
  const ids = tasks.rows.map((row) => row.id);
  const artifacts = await db.query<{ id: string }>(
    "SELECT a.id FROM pr_artifacts a JOIN pr_executions e ON e.id=a.execution_id WHERE e.task_id=ANY($1::text[]) AND a.kind IN ('SCREENSHOT','TRACE')",
    [ids],
  );
  if (apply && ids.length) {
    await db.transaction(async (client) => {
      await client.query(
        'DELETE FROM pr_artifacts WHERE execution_id IN (SELECT id FROM pr_executions WHERE task_id=ANY($1::text[]))',
        [ids],
      );
      // 保留命令事实与去重键；输入值和页面数据不无限期保留。
      await client.query(
        `UPDATE pr_commands SET envelope=jsonb_set(envelope,'{command}',jsonb_strip_nulls(jsonb_build_object('type',kind,'action',envelope#>>'{command,action}'))), result=result-'data' WHERE execution_id IN (SELECT id FROM pr_executions WHERE task_id=ANY($1::text[]))`,
        [ids],
      );
      await client.query(
        `UPDATE pr_node_inbox SET payload='{}' WHERE payload->>'sessionId' IN (SELECT s.id FROM pr_sessions s JOIN pr_executions e ON e.id=s.execution_id WHERE e.task_id=ANY($1::text[]))`,
        [ids],
      );
      await client.query(
        'UPDATE pr_tasks SET archived_at=clock_timestamp() WHERE id=ANY($1::text[])',
        [ids],
      );
      // 调用元数据仍可审计，页面、输入值与供应商回复随任务证据一起清理。
      await client.query(
        `UPDATE pr_model_calls SET record=record || '{"request":null,"response":null,"archived":true}'::jsonb WHERE execution_id IN (SELECT id FROM pr_executions WHERE task_id=ANY($1::text[]))`,
        [ids],
      );
    });
    for (const artifact of artifacts.rows)
      await unlink(join(directory, artifact.id)).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        },
      );
  }
  const orphanFiles: string[] = [];
  for (const name of await readdir(directory).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    },
  )) {
    // 只处理存储器命名规则内的普通文件，未知文件交给运维检查。
    if (
      !ID_PATTERN.test(name) &&
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.tmp$/.test(name)
    )
      continue;
    const path = join(directory, name);
    const info = await stat(path);
    if (!info.isFile() || Date.now() - info.mtimeMs < ORPHAN_GRACE_MS) continue;
    if (
      (await db.query('SELECT 1 FROM pr_artifacts WHERE id=$1', [name]))
        .rowCount
    )
      continue;
    orphanFiles.push(name);
    if (apply) await unlink(path);
  }
  if (apply)
    await db.query(
      'DELETE FROM pr_pairings WHERE expires_at<clock_timestamp()',
    );
  return {
    applied: apply,
    tasks: ids,
    screenshots: artifacts.rowCount,
    orphanFiles,
    batchLimit: RETENTION_BATCH,
    retained: 'task definitions, reports, identities and deduplication hashes',
  };
}

/** 运维入口持有与 API 相同的实例锁；运行前停止 API，默认仅预览。 */
if (
  process.argv[1]?.endsWith('/maintenance.ts') ||
  process.argv[1]?.endsWith('/maintenance.js')
) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--apply' && !/^--days=\d+$/.test(arg)))
    throw new Error('Usage: maintenance --days=30 [--apply]');
  const config = loadConfig();
  const db = new Database(config.databaseUrl);
  try {
    await db.start();
    console.log(
      JSON.stringify(
        await retain(
          db,
          config.artifactDirectory,
          Number(args.find((arg) => arg.startsWith('--days='))?.slice(7) ?? 30),
          args.includes('--apply'),
        ),
        null,
        2,
      ),
    );
  } finally {
    await db.close();
  }
}
