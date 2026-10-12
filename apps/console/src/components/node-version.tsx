import type { NodeRuntime } from '@proofrun/contracts';

/** 节点与历史任务共用版本呈现；不拿 Web/API 构建号填充未上报的节点身份。 */
export function NodeVersion({
  runtime,
}: {
  runtime: NodeRuntime | null | undefined;
}) {
  if (!runtime) return <span className="muted">未上报</span>;
  return (
    <span className="node-version">
      <span className="mono wrap">{runtime.version}</span>
      <small className="muted">
        <span title={runtime.sourceCommit ?? undefined}>
          提交 {runtime.sourceCommit?.slice(0, 8) ?? '未知'}
        </span>
        <span>引擎 {runtime.engineVersion}</span>
      </small>
    </span>
  );
}
