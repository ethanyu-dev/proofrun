import { useEffect, useRef, useState } from 'react';
import { NodeEnrollment } from '../components/node-enrollment';
import {
  NodeRoutingEditor,
  NodeRoutingSummary,
  type ConsoleNode,
} from '../components/node-routing';
import type { NodeList, NodeSummary } from '@proofrun/contracts';
import { ApiClient, errorMessage } from '../api';
import { useResource } from '../use-resource';
import {
  Empty,
  ErrorNotice,
  PageHeader,
  RefreshBar,
  time,
} from '../components/ui';

/** 能力由节点心跳声明；在线不代表任意任务都可分配。 */
const CAPABILITIES = [
  ['observe', '页面观察'],
  ['screenshot', '截图'],
  ['conditionWait', '条件等待'],
  ['writeActions', '写操作'],
  ['authState', '登录复用'],
  ['networkEvidence', '网络证据'],
] as const;

/** 占用量来自控制面并集计算，离线或待关闭会话不能被界面视为可用容量。 */
export function NodesPage({ api }: { api: ApiClient }) {
  const resource = useResource<
    Omit<NodeList, 'nodes'> & { nodes: ConsoleNode[] }
  >(api, '/v1/nodes');
  const [routingNode, setRoutingNode] = useState<NodeSummary>();
  const [savedRouting, setSavedRouting] = useState(false);
  const [rotation, setRotation] = useState<string>();
  const [enrolling, setEnrolling] = useState(false);
  const [confirm, setConfirm] = useState<string>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  const revoke = async () => {
    if (!confirm || pending) return;
    const controller = new AbortController();
    active.current = controller;
    setPending(true);
    setError(undefined);
    try {
      await api.json(
        `/v1/nodes/${encodeURIComponent(confirm)}/revoke`,
        controller.signal,
        {},
      );
      if (!controller.signal.aborted) {
        setConfirm(undefined);
        resource.refresh();
      }
    } catch (error) {
      if (!controller.signal.aborted) setError(errorMessage(error));
    } finally {
      if (!controller.signal.aborted) setPending(false);
    }
  };
  return (
    <>
      <PageHeader
        title="执行节点"
        description="查看内网节点、浏览器容量与连接状态。"
      >
        <button
          className="button button-primary"
          onClick={() => setEnrolling(true)}
        >
          注册节点
        </button>
      </PageHeader>
      {rotation && (
        <NodeEnrollment
          key={rotation}
          api={api}
          nodeId={rotation}
          close={() => setRotation(undefined)}
        />
      )}
      {enrolling && (
        <NodeEnrollment api={api} close={() => setEnrolling(false)} />
      )}
      {routingNode && (
        <NodeRoutingEditor
          key={routingNode.id}
          api={api}
          node={routingNode}
          close={() => setRoutingNode(undefined)}
          saved={() => {
            setRoutingNode(undefined);
            setSavedRouting(true);
            resource.refresh();
          }}
        />
      )}
      {savedRouting && <p role="status">域名配置已保存，对后续分配生效。</p>}
      <ErrorNotice message={error} />
      {confirm && (
        <div className="confirm-panel" role="alert">
          <p>
            撤销节点 {confirm}{' '}
            的连接凭据并停止关联任务。已发生的业务操作不会撤销，未确认关闭的会话仍保留占用。
          </p>
          <div className="page-actions">
            <button
              className="button button-primary"
              disabled={pending}
              onClick={() => void revoke()}
            >
              确认撤销
            </button>
            <button
              className="button button-secondary"
              disabled={pending}
              onClick={() => setConfirm(undefined)}
            >
              返回
            </button>
          </div>
        </div>
      )}
      <RefreshBar {...resource} />
      <ErrorNotice message={resource.error} />
      {!resource.data ? (
        <Empty title={resource.loading ? '正在读取节点…' : '节点读取失败'} />
      ) : resource.data.nodes.length === 0 ? (
        <Empty title="尚无注册节点">
          节点完成配对并连接控制面后将在这里显示。
        </Empty>
      ) : (
        <>
          <div className="node-grid">
            {resource.data.nodes.map((node) => (
              <article className="panel node-card" key={node.id}>
                <header className="node-header">
                  <div className="node-identity">
                    <h2>{node.name}</h2>
                    <p className="node-pool muted">节点池 · {node.pool}</p>
                  </div>
                  <span
                    className="status node-status"
                    data-tone={
                      node.revoked_at
                        ? 'danger'
                        : node.online
                          ? 'success'
                          : undefined
                    }
                  >
                    <span className="node-status-dot" aria-hidden="true" />
                    {node.revoked_at ? '已撤销' : node.online ? '在线' : '离线'}
                  </span>
                </header>
                <p className="node-id mono muted wrap">
                  <span> ID </span>
                  {node.id}
                </p>
                <section className="node-capacity" aria-label="浏览器容量">
                  <dl className="node-capacity-facts">
                    <div>
                      <dt>占用 / 总容量</dt>
                      <dd className="capacity-number">
                        {node.occupied}
                        <span> / {node.capacity}</span>
                      </dd>
                    </div>
                    <div>
                      <dt>空闲槽位</dt>
                      <dd className="node-availability">
                        {node.online && !node.revoked_at ? (
                          <>
                            {Math.max(0, node.capacity - node.occupied)}
                            <span> 个</span>
                          </>
                        ) : (
                          '不可分配'
                        )}
                      </dd>
                    </div>
                  </dl>
                  {/* 进度仅表达占用比例；容量为零或占用超额时仍保留上方真实数字。 */}
                  <div className="node-capacity-track" aria-hidden="true">
                    <span
                      style={{
                        width: `${node.capacity > 0 ? Math.min(100, Math.max(0, (node.occupied / node.capacity) * 100)) : 0}%`,
                      }}
                    />
                  </div>
                </section>
                <section className="node-capabilities" aria-label="节点能力">
                  <h3>节点能力</h3>
                  <ul className="node-capability-list">
                    {CAPABILITIES.map(([key, label]) => (
                      <li
                        key={key}
                        data-supported={node.capabilities[key] === true}
                      >
                        <span aria-hidden="true">
                          {node.capabilities[key] === true ? '✓' : '−'}
                        </span>
                        <span>
                          {label}
                          {node.capabilities[key] === true ? (
                            <span className="sr-only"> · 支持</span>
                          ) : (
                            <span className="node-capability-unavailable">
                              {' '}
                              · 未开放
                            </span>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
                <NodeRoutingSummary
                  node={node}
                  edit={(node) => {
                    setRoutingNode(node);
                    setSavedRouting(false);
                  }}
                />
                <footer className="node-footer">
                  <p className="node-heartbeat muted">
                    最近心跳 <span>{time(node.last_seen_at)}</span>
                  </p>
                  {!node.revoked_at && (
                    <div
                      className="node-actions"
                      role="group"
                      aria-label={`${node.name} 管理操作`}
                    >
                      {node.occupied === 0 && (
                        <button
                          className="text-button"
                          onClick={() => setRotation(node.id)}
                        >
                          轮换凭据
                        </button>
                      )}
                      <button
                        className="text-button node-revoke"
                        onClick={() => setConfirm(node.id)}
                      >
                        撤销节点
                      </button>
                    </div>
                  )}
                </footer>
              </article>
            ))}
          </div>
          <p className="muted note node-list-note">
            占用包含尚未确认关闭的会话。任务分配还受节点池、能力和执行预算约束。
          </p>
        </>
      )}
    </>
  );
}
