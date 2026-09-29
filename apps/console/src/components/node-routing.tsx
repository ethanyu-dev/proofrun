import { useEffect, useRef, useState } from 'react';
import type { NodeSummary } from '@proofrun/contracts';
import { ApiClient, errorMessage } from '../api';
import { ErrorNotice } from './ui';

/** 前后端分批更新时，旧控制面仍可返回不含域名配置的节点信息。 */
export type ConsoleNode = Omit<
  NodeSummary,
  'routing_domains' | 'routing_revision'
> &
  Partial<Pick<NodeSummary, 'routing_domains' | 'routing_revision'>>;

/** 同时检查列表与版本；缺字段不能当作空配置，更不能猜测写入版本。 */
function hasRouting(node: ConsoleNode): node is NodeSummary {
  return (
    Array.isArray(node.routing_domains) &&
    node.routing_domains.every((domain) => typeof domain === 'string') &&
    typeof node.routing_revision === 'number' &&
    Number.isSafeInteger(node.routing_revision) &&
    node.routing_revision >= 0
  );
}

/** 卡片保留旧版节点的其他能力，仅在完整配置可用时开放编辑。 */
export function NodeRoutingSummary({
  node,
  edit,
}: {
  node: ConsoleNode;
  edit: (node: NodeSummary) => void;
}) {
  const available = hasRouting(node);
  return (
    <section className="node-routing" aria-label="域名分发">
      <div className="node-routing-content">
        <h3>域名分发</h3>
        {!available ? (
          <p className="muted note">
            控制面未返回完整域名配置，请更新并重启 API 后刷新。
          </p>
        ) : node.routing_domains.length ? (
          <ul className="node-domain-list mono wrap">
            {node.routing_domains.map((domain) => (
              <li key={domain}>{domain}</li>
            ))}
          </ul>
        ) : (
          <p className="muted note">未绑定域名</p>
        )}
      </div>
      <button
        className="button button-secondary button-small"
        disabled={!available}
        onClick={() => {
          if (hasRouting(node)) edit(node);
        }}
      >
        配置域名
      </button>
    </section>
  );
}

/** 编辑使用打开时的配置快照；后台刷新不能覆盖输入，服务端版本检查防止覆盖他人修改。 */
export function NodeRoutingEditor({
  api,
  node,
  close,
  saved,
}: {
  api: ApiClient;
  node: ConsoleNode;
  close: () => void;
  saved: () => void;
}) {
  const available = hasRouting(node);
  const [text, setText] = useState(() =>
    available ? node.routing_domains.join('\n') : '',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);

  /** 一次提交整个域名列表；网络结果未确认时交由用户刷新核查。 */
  const submit = async () => {
    if (busy || !hasRouting(node)) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError(undefined);
    try {
      await api.json(
        `/v1/nodes/${encodeURIComponent(node.id)}/routing`,
        controller.signal,
        {
          domains: text
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean),
          revision: node.routing_revision,
        },
      );
      if (!controller.signal.aborted) saved();
    } catch (error) {
      if (!controller.signal.aborted) setError(errorMessage(error));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  if (!available)
    return (
      <ErrorNotice message="控制面未返回完整域名配置，请更新并重启 API 后刷新。" />
    );

  return (
    <section className="panel" aria-label="配置域名分发">
      <div className="section-heading">
        <h2>域名分发 · {node.name}</h2>
        <button
          className="button button-secondary"
          disabled={busy}
          onClick={close}
        >
          关闭
        </button>
      </div>
      <p>
        节点池：{node.pool}。每行一个完整域名，例如
        a.internal.example，不含协议、端口或路径，不支持通配符。
      </p>
      <p className="muted note">
        仅匹配任务初始 URL
        的完整域名，不包含子域名。匹配后固定到此节点；离线、满载、能力不足或登录节点冲突时等待至任务截止。未匹配域名按原资源池策略分配。
      </p>
      <ErrorNotice message={error} />
      <form
        className="control-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label>
          绑定域名
          <textarea
            rows={5}
            value={text}
            disabled={busy || Boolean(node.revoked_at)}
            onChange={(event) => setText(event.target.value)}
            placeholder={'a.internal.example\nb.internal.example'}
          />
        </label>
        <p className="muted note">
          保存后对尚未分配的任务生效，正在执行的任务保持原节点。清空列表并保存可解除绑定。
        </p>
        {node.revoked_at && (
          <p>
            此节点已撤销，原绑定仍会阻止任务改派。请清空并保存，再到其他节点重新配置。
          </p>
        )}
        <div className="page-actions">
          <button className="button button-primary" disabled={busy}>
            {busy ? '保存中…' : '保存域名配置'}
          </button>
          <button
            type="button"
            className="button button-secondary"
            disabled={busy}
            onClick={() => setText('')}
          >
            清空列表
          </button>
        </div>
      </form>
    </section>
  );
}
