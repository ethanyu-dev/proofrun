import { KeyRound, Trash2 } from 'lucide-react';
import { DialogFooter } from '../components/ui/dialog';
import {
  NodeDefaultProfile,
  NodeProfileAction,
} from '../components/node-default-profile';
import { toast } from 'sonner';
import { Modal } from '../components/modal';
import { Button } from '../components/ui/button';
import { useEffect, useRef, useState } from 'react';
import { NodeEnrollment } from '../components/node-enrollment';
import { NodeVersion } from '../components/node-version';
import {
  NodeRoutingEditor,
  NodeRoutingSummary,
  NodeRoutingAction,
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
  ['ephemeralProfiles', '临时身份会话'],
  ['networkEvidence', '网络证据'],
  ['reducedMotion', '动画偏好'],
] as const;

/** 占用量来自控制面并集计算，离线或待关闭会话不能被界面视为可用容量。 */
export function NodesPage({ api }: { api: ApiClient }) {
  const resource = useResource<
    Omit<NodeList, 'nodes'> & { nodes: ConsoleNode[] }
  >(api, '/v1/nodes');
  const [routingNode, setRoutingNode] = useState<NodeSummary>();
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
        toast.success('节点凭据已撤销');
        resource.refresh();
      }
    } catch (error) {
      if (!controller.signal.aborted) setError(errorMessage(error));
    } finally {
      if (!controller.signal.aborted) setPending(false);
    }
  };
  return (
    <div className="nodes-page">
      <PageHeader
        title="执行节点"
        description="查看内网节点、浏览器容量与连接状态。"
      >
        <Button
          variant="default"
          className="button button-primary"
          onClick={() => setEnrolling(true)}
        >
          注册节点
        </Button>
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
            toast.success('域名配置已保存');
            resource.refresh();
          }}
        />
      )}
      <ErrorNotice message={error} />
      {confirm && (
        <Modal
          title="撤销节点"
          close={() => setConfirm(undefined)}
          busy={pending}
          className="node-management-dialog"
        >
          <ErrorNotice message={error} />
          <p>
            撤销节点 {confirm}{' '}
            的连接凭据并停止关联任务。已发生的业务操作不会撤销，未确认关闭的会话仍保留占用。
          </p>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={pending}
              data-dialog-cancel
              onClick={() => setConfirm(undefined)}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() => void revoke()}
            >
              {pending ? '正在撤销…' : '确认撤销'}
            </Button>
          </DialogFooter>
        </Modal>
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
                <dl className="node-runtime">
                  <dt>
                    {node.online && !node.revoked_at
                      ? '运行版本'
                      : '最后上报版本'}
                  </dt>
                  <dd>
                    <NodeVersion runtime={node.runtime} />
                  </dd>
                </dl>
                <section className="node-capacity" aria-label="节点资源准入">
                  <dl className="node-capacity-facts">
                    <div>
                      <dt>活动会话</dt>
                      <dd>{node.occupied}</dd>
                    </div>
                    <div>
                      <dt>接收新任务</dt>
                      <dd>
                        {node.online &&
                        !node.revoked_at &&
                        node.admission?.accepting
                          ? '允许'
                          : '暂停'}
                      </dd>
                    </div>
                    <div>
                      <dt>资源状态</dt>
                      <dd>{admissionReason(node.admission?.reason)}</dd>
                    </div>
                    <div>
                      <dt>CPU 利用率</dt>
                      <dd>{node.admission?.cpuPercent?.toFixed(1) ?? '—'}%</dd>
                    </div>
                    <div>
                      <dt>可用内存</dt>
                      <dd>
                        {node.admission?.availableBytes == null
                          ? '—'
                          : `${(node.admission.availableBytes / 1024 ** 3).toFixed(2)} GiB`}
                      </dd>
                    </div>
                    <div>
                      <dt>客户端直连地址</dt>
                      <dd className="wrap">
                        {node.public_url ?? '未配置 public_url'}
                      </dd>
                    </div>
                  </dl>
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
                <NodeDefaultProfile node={node} />
                <NodeRoutingSummary node={node} />
                <footer className="node-footer">
                  <div
                    className="node-actions"
                    role="group"
                    aria-label={`${node.name} 管理操作`}
                  >
                    <NodeRoutingAction node={node} edit={setRoutingNode} />
                    <NodeProfileAction api={api} node={node} />
                    {!node.revoked_at && (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={node.occupied !== 0}
                          title={
                            node.occupied !== 0
                              ? '请等待会话结束后轮换凭据'
                              : undefined
                          }
                          onClick={() => setRotation(node.id)}
                        >
                          <KeyRound aria-hidden="true" />
                          轮换凭据
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="node-revoke"
                          onClick={(event) => {
                            event.currentTarget.focus();
                            setConfirm(node.id);
                          }}
                        >
                          <Trash2 aria-hidden="true" />
                          撤销节点
                        </Button>
                      </>
                    )}
                  </div>
                  <p className="node-heartbeat muted">
                    最近心跳 <span>{time(node.last_seen_at)}</span>
                  </p>
                </footer>
              </article>
            ))}
          </div>
          <p className="muted note node-list-note">
            占用包含尚未确认关闭的会话。任务分配还受节点池、能力和执行预算约束。
          </p>
        </>
      )}
    </div>
  );
}

/** 把节点资源诊断映射成操作者可理解的状态。 */
function admissionReason(reason?: string) {
  return (
    (
      {
        READY: '资源充足',
        CPU_SAMPLE_PENDING: '正在采样',
        METRICS_UNAVAILABLE: '无法读取资源指标',
        RECOVERY_REQUIRED: '等待异常会话清理',
        STARTUP_SETTLING: '等待新会话稳定',
        MEMORY_PRESSURE: '内存余量不足',
        CPU_OR_MEMORY_PRESSURE: 'CPU 或内存压力较高',
      } as Record<string, string>
    )[reason ?? ''] ?? '等待节点上报'
  );
}
