import { auditDirectory } from './acceptance/audit.mjs';

/** 显式目录决定样本集合；不自动挑选成功记录或把同一任务重复计数。 */
const directories = process.argv.slice(2);
if (!directories.length) {
  console.error('用法：pnpm audit:acceptance <验收目录> [其他验收目录...]');
  process.exitCode = 2;
} else {
  const runs = [];
  const identities = new Set();
  for (const directory of directories) {
    const run = await auditDirectory(directory);
    const identity = run.taskId ?? run.directory;
    if (identities.has(identity)) {
      run.issues.push({ code: 'DUPLICATE_SAMPLE', item: identity });
      run.integrity = 'INVALID_OR_INCOMPLETE';
    }
    identities.add(identity);
    runs.push(run);
  }
  console.log(
    JSON.stringify(
      {
        formatVersion: 1,
        auditedAt: new Date().toISOString(),
        sampleCount: runs.length,
        verifiedCount: runs.filter((run) => run.integrity === 'VERIFIED')
          .length,
        // 历史任务可能跨版本、预算和环境；此工具不计算业务成功率或策略胜率。
        businessSuccessRate: null,
        runs,
      },
      null,
      2,
    ),
  );
  process.exitCode = runs.every((run) => run.integrity === 'VERIFIED') ? 0 : 1;
}
