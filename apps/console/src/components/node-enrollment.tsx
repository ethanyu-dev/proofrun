import { useEffect, useRef, useState } from 'react';
import { ApiClient, errorMessage } from '../api';
import { ErrorNotice, time } from './ui';

/** 一次性配对码只留在当前组件内存；关闭页面即清除。 */
export function NodeEnrollment({
  api,
  close,
  nodeId,
}: {
  api: ApiClient;
  close: () => void;
  nodeId?: string;
}) {
  const [name, setName] = useState('');
  const [pool, setPool] = useState('default');
  const [pairing, setPairing] = useState<{
    pairingToken: string;
    expiresAt: string;
    pool: string;
  }>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  const submit = async () => {
    if (busy) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.json<{
        pairingToken: string;
        expiresAt: string;
        pool: string;
      }>(
        nodeId
          ? `/v1/nodes/${encodeURIComponent(nodeId)}/rotation`
          : '/v1/node-pairings',
        controller.signal,
        nodeId ? {} : { type: 'node.enroll', name: name.trim(), pool },
      );
      if (!controller.signal.aborted) setPairing(result);
    } catch (error) {
      if (!controller.signal.aborted) setError(errorMessage(error));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  return (
    <section className="panel" aria-label="注册执行节点">
      <div className="section-heading">
        <h2>{nodeId ? '轮换节点凭据' : '注册执行节点'}</h2>
        <button className="button button-secondary" onClick={close}>
          关闭
        </button>
      </div>
      <ErrorNotice message={error} />
      {!pairing ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          className="control-form"
        >
          {!nodeId && (
            <>
              <label>
                节点名称
                <input
                  required
                  maxLength={128}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label>
                节点池
                <input
                  required
                  pattern="[A-Za-z0-9_-]+"
                  maxLength={128}
                  value={pool}
                  onChange={(e) => setPool(e.target.value)}
                />
              </label>
            </>
          )}
          <button
            className="button button-primary"
            disabled={busy || (!nodeId && !name.trim())}
          >
            {busy ? '签发中…' : '生成配对码'}
          </button>
        </form>
      ) : (
        <>
          {nodeId && (
            <p>
              停止此节点服务后使用下方配对码轮换，再启动服务。有效期内该节点暂停接收新任务。原节点身份和执行账本保留。
            </p>
          )}
          <p>
            节点池：{pairing.pool} · 有效期至 {time(pairing.expiresAt)}
            ，仅可使用一次。
          </p>
          <label>
            配对码
            <input
              className="mono"
              readOnly
              value={pairing.pairingToken}
              onFocus={(e) => e.target.select()}
            />
          </label>
          <ol>
            <li>在远端节点配置中填写相同节点池和控制面地址。</li>
            <li>将配对码保存到仅节点运行用户可读的文件，然后运行：</li>
          </ol>
          <pre className="evidence-text">
            proofrun-node --config /etc/proofrun/node.toml pair
            --pairing-token-file /private/path/pairing-token
            {nodeId ? ' --replace-credential' : ''}
          </pre>
          <p>配对成功后删除配对码文件，启动节点服务；节点将主动连接控制面。</p>
        </>
      )}
    </section>
  );
}
