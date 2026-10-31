/** 发布前保留最新九份，给本次快照留出一个名额；不根据名称猜测时间。 */
const RETAIN_BEFORE_RELEASE = 9;
/** 删除异步执行，同卷只允许一个删除工作流；等待有界，失败时不能继续发布。 */
const DELETE_TIMEOUT_MS = 20 * 60_000;
const POLL_MS = 10_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 删除前校验完整列表；缺少时间或身份时停止，避免误删较新的恢复点。 */
function orderedBackups(backups) {
  if (
    !Array.isArray(backups) ||
    backups.some(
      (backup) =>
        !backup ||
        typeof backup.id !== 'string' ||
        !backup.id ||
        typeof backup.name !== 'string' ||
        typeof backup.createdAt !== 'string' ||
        !Number.isFinite(Date.parse(backup.createdAt)),
    ) ||
    new Set(backups.map((backup) => backup.id)).size !== backups.length
  )
    throw new Error('备份身份或创建时间无效，停止清理和发布');
  return [...backups].sort(
    (a, b) =>
      Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
      a.id.localeCompare(b.id),
  );
}

/** 每次重读后只删除最旧一份；复用本次备份，未知删除结果不自动重放。 */
export async function retainReleaseBackups(
  { service, backupName, list, remove },
  { wait = sleep, now = Date.now } = {},
) {
  const deadline = now() + DELETE_TIMEOUT_MS;
  for (;;) {
    const backups = orderedBackups(await list());
    if (
      backups.some((backup) => backup.name === backupName) ||
      backups.length <= RETAIN_BEFORE_RELEASE
    )
      return backups;
    if (now() >= deadline) throw new Error(`${service} 备份清理超时，停止发布`);
    const oldest = backups[0];
    console.log(`${service} 清理最旧备份：${oldest.id} / ${oldest.createdAt}`);
    try {
      await remove(oldest.id);
    } catch (error) {
      // 平台明确拒绝并发删除时才等待重试；网络超时可能已受理，必须停止而非重放。
      if (error.code !== 'BACKUP_DELETION_IN_PROGRESS') throw error;
      await wait(POLL_MS);
      continue;
    }
    for (;;) {
      const remaining = orderedBackups(await list());
      if (!remaining.some((backup) => backup.id === oldest.id)) break;
      if (now() >= deadline)
        throw new Error(`${service} 备份删除未完成，停止发布`);
      await wait(POLL_MS);
    }
    // 列表移除可能先于后台工作流结束，避免紧接着发起同卷删除。
    await wait(POLL_MS);
  }
}
