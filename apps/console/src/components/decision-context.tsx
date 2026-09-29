import { useState } from 'react';
import type { ModelCall } from '@proofrun/contracts';
import { ApiClient } from '../api';
import { useResource } from '../use-resource';
import { contextModules, moduleText } from '../context-modules';
import { ErrorNotice, time } from './ui';

/** 接收状态与决定有效性分开命名，收到工具回复不能冒充业务验收通过。 */
const CALL_STATUS = {
  PENDING: '等待回复',
  RECEIVED: '已收到回复',
  ERROR: '请求异常',
};
const PURPOSE = {
  DECISION: '决策',
  JEV_SELECTION: 'JEV 候选选择',
  FIELD_VALUE: '填写值生成',
};
type CallSummary = Omit<ModelCall, 'request' | 'response'>;

/** 单次正文按需读取，模块折叠保留全文，页面内容始终作为纯文本展示。 */
function CallDetails({
  api,
  path,
  pending,
}: {
  api: ApiClient;
  path: string;
  pending: boolean;
}) {
  const detail = useResource<ModelCall>(api, path, pending);
  const [view, setView] = useState<'modules' | 'request' | 'response'>(
    'modules',
  );
  const call = detail.data;
  let request: Record<string, unknown> | undefined;
  if (call?.request) {
    try {
      request = JSON.parse(call.request);
    } catch {
      /* 保留原文入口用于诊断损坏的记录。 */
    }
  }
  return (
    <div className="context-detail">
      <ErrorNotice message={detail.error} />
      {!call ? (
        <p className="muted">
          {detail.loading
            ? '正在读取本次调用…'
            : '未能读取本次调用，请刷新重试。'}
        </p>
      ) : (
        <>
          <dl className="facts context-call-facts">
            <div>
              <dt>实际模型 / 用途</dt>
              <dd>
                {call.model} · {PURPOSE[call.purpose]}
              </dd>
            </div>
            <div>
              <dt>开始时间</dt>
              <dd>{time(call.startedAt)}</dd>
            </div>
            <div>
              <dt>请求状态 / 耗时</dt>
              <dd>
                {CALL_STATUS[call.status]} ·{' '}
                {call.elapsedMs === null
                  ? '未记录'
                  : `${(call.elapsedMs / 1000).toFixed(1)} 秒`}
              </dd>
            </div>
            <div>
              <dt>输入 / 输出 token</dt>
              <dd>
                {call.promptTokens ?? '未报告'} /{' '}
                {call.completionTokens ?? '未报告'}
              </dd>
            </div>
          </dl>
          <p className="muted note context-note">
            保存的是实际请求正文；模块字符数不是 token
            数。收到回复不代表决定有效或验收通过。
            {call.imagesOmitted > 0 &&
              ' 图片 base64 已替换为已有截图证据引用。'}
          </p>
          {call.error && (
            <ErrorNotice message={`本次请求异常：${call.error}`} />
          )}
          {call.archived ? (
            <p className="muted">
              本次调用正文已按任务保留策略清理，元数据仍可查看。
            </p>
          ) : (
            <div className="context-content">
              <div
                className="context-view-switch"
                role="group"
                aria-label="上下文查看方式"
              >
                {(['modules', 'request', 'response'] as const).map((mode) => (
                  <button
                    key={mode}
                    className="context-view-button"
                    aria-pressed={view === mode}
                    onClick={() => setView(mode)}
                  >
                    {
                      {
                        modules: '按模块查看',
                        request: '请求 JSON',
                        response: '模型回复',
                      }[mode]
                    }
                  </button>
                ))}
              </div>
              {view === 'modules' && request && (
                <div className="context-modules">
                  {contextModules(request).map((module, index) => {
                    const text = moduleText(module.value);
                    return (
                      <details
                        className="context-module"
                        key={`${call.id}-${index}`}
                      >
                        <summary>
                          <span>{module.title}</span>
                          <span className="muted">
                            {text.length.toLocaleString()} 字符
                          </span>
                        </summary>
                        <p className="mono muted note">{module.path}</p>
                        <pre>{text}</pre>
                      </details>
                    );
                  })}
                </div>
              )}
              {view === 'modules' && !request && (
                <p className="muted">无法拆分本次正文，请查看请求 JSON。</p>
              )}
              {view === 'request' && (
                <pre className="context-raw">
                  {request
                    ? moduleText(request)
                    : (call.request ?? '请求正文未记录')}
                </pre>
              )}
              {view === 'response' && (
                <pre className="context-raw">
                  {call.response
                    ? moduleText(JSON.parse(call.response))
                    : call.status === 'PENDING'
                      ? '尚未收到回复；若执行已结束，可能没有交付回执。'
                      : '没有模型回复正文'}
                </pre>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** 列表按实际供应商请求选择，同一决策轮次的混合子调用和重试均单独展示。 */
export function DecisionContext({
  api,
  executionId,
  running,
}: {
  api: ApiClient;
  executionId: string;
  running: boolean;
}) {
  const base = `/v1/admin/executions/${encodeURIComponent(executionId)}/model-calls`;
  const resource = useResource<{ calls: CallSummary[] }>(api, base, running);
  const [selected, setSelected] = useState<string>();
  const calls = resource.data?.calls ?? [];
  const current = calls.find((call) => call.id === selected) ?? calls[0];
  return (
    <section className="panel decision-context" aria-label="决策上下文">
      <div className="section-heading">
        <h2>决策上下文</h2>
        <button
          className="button button-secondary button-small"
          disabled={resource.loading}
          onClick={resource.refresh}
        >
          刷新调用记录
        </button>
      </div>
      <ErrorNotice message={resource.error} />
      {!resource.data ? (
        <p className="muted">
          {resource.loading ? '正在读取调用记录…' : '暂时无法读取调用记录。'}
        </p>
      ) : !calls.length ? (
        <p className="muted">
          {running
            ? '尚未记录模型请求，首次调用前会保存上下文。'
            : '本次执行未记录决策上下文。旧任务的每轮原始请求无法精确回放；启用记录后运行的任务可在此查看。'}
        </p>
      ) : (
        <>
          <label className="context-picker">
            选择决策轮次与模型调用
            <select
              value={current?.id}
              onChange={(event) => setSelected(event.target.value)}
            >
              {calls.map((call) => (
                <option key={call.id} value={call.id}>
                  第 {call.decisionIndex} 轮 · 调用 #{call.callIndex} ·{' '}
                  {call.model} · {PURPOSE[call.purpose]} ·{' '}
                  {CALL_STATUS[call.status]}
                </option>
              ))}
            </select>
          </label>
          {current && (
            <CallDetails
              key={current.id}
              api={api}
              path={`${base}/${encodeURIComponent(current.id)}`}
              pending={running && current.status === 'PENDING'}
            />
          )}
        </>
      )}
    </section>
  );
}
