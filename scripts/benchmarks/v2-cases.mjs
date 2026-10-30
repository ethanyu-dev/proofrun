import { randomUUID } from 'node:crypto';
import { v2BenchmarkCases } from '../../contracts/dist/benchmark-v2.js';
export { V2_CASE_IDS } from '../../contracts/dist/benchmark-v2.js';
export {
  V2_CONTEXT_CHARS,
  v2CallLimit,
  v2TimeLimit,
} from '../../contracts/dist/benchmark-scenarios.js';

/** 本地执行与线上调度共用冻结定义，仅指定本地访客环境和独立任务身份。 */
export async function v2Cases() {
  return v2BenchmarkCases((id) => `benchmark-v2-${id}-${randomUUID()}`, {
    id: 'local-live-benchmark',
    nodePool: 'local-live-benchmark',
    allowIntervention: false,
  });
}
