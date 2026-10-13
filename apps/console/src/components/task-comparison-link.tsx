import type { TaskSummary } from '@proofrun/contracts';

/** 只对已保存的双跑关联展示入口；从任一组进入现有详情页都会读取两组。 */
export function TaskComparisonLink({
  id,
  comparison,
}: {
  /** 当前组的任务身份，对比页由服务端解析另一组。 */
  id: string;
  /** 缺失关联时兼容旧响应，不展示无法核实的双跑入口。 */
  comparison: TaskSummary['comparison'];
}) {
  if (!comparison) return null;
  return (
    <a
      className="button button-secondary button-small"
      href={`#/tasks/${encodeURIComponent(id)}`}
    >
      查看双跑对比
    </a>
  );
}
