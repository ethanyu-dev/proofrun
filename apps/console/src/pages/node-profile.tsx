import { useState } from 'react';
import { ApiClient, errorMessage } from '../api';
import { useResource } from '../use-resource';
import { ErrorNotice, PageHeader, RefreshBar, time } from '../components/ui';
import { Button } from '../components/ui/button';
import { Modal } from '../components/modal';

/** 维护状态来自持久发布回执；浏览器关闭和模板保存分别展示。 */
interface ProfileStatus {
  /** 内部维护身份及所属资源，仅用于查询和跳转。 */
  id: string;
  taskId: string;
  nodeId: string;
  managed: boolean;
  /** 初始导航成功且未开始保存时可进入人工操作。 */
  ready: boolean;
  /** 物理关闭事实与任务正在关闭状态分别呈现。 */
  closed: boolean;
  closing: boolean;
  /** 发布意图和节点回执共同决定的持久状态。 */
  publishState: 'IDLE' | 'SAVING' | 'SAVED' | 'FAILED' | 'DISCARDED';
  /** 只含公开版本元数据，不含登录材料。 */
  profile: { version: string; updatedAt: string } | null;
  /** 失败原因及经管理员授权返回的 HITL 入口。 */
  failureCode: string | null;
  path: string | null;
}
/** 页面只轮询状态，首次导航和断线后的保存恢复都由服务端负责。 */
export function NodeProfilePage({ api, id }: { api: ApiClient; id: string }) {
  const resource = useResource<ProfileStatus>(api, `/v1/node-profiles/${id}`);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const data = resource.data;
  const discard = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await api.json(
        `/v1/node-profiles/${id}/close`,
        new AbortController().signal,
        {},
      );
      setConfirm(false);
      resource.refresh();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <PageHeader
        title="维护节点登录状态"
        description="保存后的版本供该节点后续任务复制，已有任务继续使用原副本。"
      >
        <a href="#/nodes">返回节点管理</a>
      </PageHeader>
      <RefreshBar {...resource} />
      <ErrorNotice message={resource.error ?? error} />
      {data && (
        <section className="panel">
          <p>
            {!data.managed
              ? '历史维护记录'
              : {
                  IDLE: data.ready
                    ? '浏览器已就绪'
                    : data.closed || data.closing
                      ? '维护已结束'
                      : '正在启动浏览器…',
                  SAVING: '正在保存，请等待发布和关闭确认…',
                  SAVED: '默认登录状态已保存',
                  FAILED: '保存失败，原默认版本保持不变或发布结果尚未确认',
                  DISCARDED: '已放弃修改，默认版本保持不变',
                }[data.publishState]}
          </p>
          <p>
            浏览器：
            {data.closed ? '已关闭' : data.closing ? '正在关闭' : '运行中'}
          </p>
          {data.profile && (
            <p>
              版本 {data.profile.version} · {time(data.profile.updatedAt)}
            </p>
          )}
          {data.failureCode && <p role="alert">原因：{data.failureCode}</p>}
          <div className="page-actions">
            {data.ready && data.path && (
              <a
                className="button button-primary"
                href={data.path}
                target="_blank"
                rel="noopener noreferrer"
              >
                进入登录维护
              </a>
            )}
            {!data.closed &&
              !data.closing &&
              data.publishState !== 'SAVING' && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => setConfirm(true)}
                >
                  放弃修改并关闭
                </Button>
              )}
            {!data.managed && <a href={`#/tasks/${data.taskId}`}>查看原任务</a>}
          </div>
          <p className="muted">
            已保存表示模板发布成功；网站登录是否仍有效，会在任务执行时核验。
          </p>
        </section>
      )}
      {confirm && (
        <Modal title="放弃本次修改" busy={busy} close={() => setConfirm(false)}>
          <p>关闭维护浏览器，本次登录和修改不会保存到默认模板。</p>
          <ErrorNotice message={error} />
          <Button disabled={busy} onClick={() => void discard()}>
            放弃并关闭
          </Button>
        </Modal>
      )}
    </div>
  );
}
