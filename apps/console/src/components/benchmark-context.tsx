import { useState } from 'react';
import type { ModelCall } from '@proofrun/contracts';
import {
  benchmarkContext,
  benchmarkTools,
  type BenchmarkCommand,
} from '@proofrun/contracts/benchmark';
import { Button } from './ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './ui/tabs';

/** 颜色只标识模块，不表示成功或失败；浅深主题共用并提供文字图例。 */
export const MODULE_LABELS = {
  task: '任务',
  state: '状态',
  page: '页面',
  history: '历史',
  evidence: '证据',
  budget: '预算',
  feedback: '反馈',
};

/** 堆叠条显示七模块占正文的比例，JSON 结构开销保留为空白余量。 */
export function ContextBar({ call }: { call: ModelCall }) {
  const data = benchmarkContext(call);
  if (!data) return <span className="muted">上下文未记录</span>;
  return (
    <div
      className="bench-context-bar"
      role="img"
      aria-label={`上下文 ${data.total} 字符；${data.modules.map((part) => `${MODULE_LABELS[part.key]} ${part.chars}`).join('，')}；结构开销 ${data.envelope}`}
    >
      {data.modules.map((part) => (
        <span
          key={part.key}
          data-module={part.key}
          style={{ width: `${(part.chars / data.total) * 100}%` }}
          title={`${MODULE_LABELS[part.key]} ${part.chars.toLocaleString()} 字符`}
        />
      ))}
    </div>
  );
}

/** 单轮详情展示保存原文与执行回执；任何页面文本仅按纯文本渲染。 */
export function BenchmarkContext({
  call,
  commands,
}: {
  call: ModelCall;
  commands: BenchmarkCommand[];
}) {
  const [module, setModule] = useState<keyof typeof MODULE_LABELS>('page');
  const data = benchmarkContext(call);
  const selected = data?.modules.find((part) => part.key === module);
  return (
    <div className="bench-inspector">
      <div className="bench-section-title">
        <h3>
          轮次 {call.decisionIndex}{' '}
          <span className="muted">/ {call.stepId ?? '当前步骤'}</span>
        </h3>
        <span className="mono">{call.elapsedMs ?? '—'} ms</span>
      </div>
      <p className="muted note">
        调用记录 token：输入 {call.promptTokens ?? '—'} / 输出{' '}
        {call.completionTokens ?? '—'} · 图片 {call.imagesOmitted}{' '}
        张（原文省略二进制）
      </p>
      <Tabs defaultValue="context">
        <TabsList aria-label="轮次诊断">
          <TabsTrigger value="context">Context 分布</TabsTrigger>
          <TabsTrigger value="tools">工具与回执</TabsTrigger>
          <TabsTrigger value="raw">原始请求</TabsTrigger>
        </TabsList>
        <TabsContent value="context">
          {data ? (
            <>
              <div className="bench-inline-stats">
                <span>
                  正文 <b>{data.total.toLocaleString()}</b>
                </span>
                <span>
                  系统指令 <b>{data.systemChars.toLocaleString()}</b>
                </span>
                <span>
                  工具定义 <b>{data.toolsChars.toLocaleString()}</b>
                </span>
              </div>
              <ContextBar call={call} />
              <div className="bench-inline-stats" aria-label="页面内容细分">
                {data.pageParts.map((part) => (
                  <span key={part.key}>
                    {part.label} <b>{part.chars.toLocaleString()}</b>{' '}
                    <small>
                      {((part.chars / data.total) * 100).toFixed(1)}%
                    </small>
                  </span>
                ))}
                <span>
                  视图{' '}
                  <b>
                    {(
                      {
                        page: '页面',
                        network: '网络',
                        runtime: '运行时',
                      } as Record<string, string>
                    )[String(data.context.page?.view)] ?? '页面'}
                  </b>
                </span>
              </div>
              <div className="bench-module-grid">
                {data.modules.map((part) => (
                  <Button
                    variant="ghost"
                    key={part.key}
                    aria-pressed={module === part.key}
                    className="bench-module"
                    onClick={() => setModule(part.key)}
                  >
                    <span>
                      <i data-module={part.key} />
                      {MODULE_LABELS[part.key]}
                    </span>
                    <span className="mono">
                      {part.chars.toLocaleString()}{' '}
                      <small>
                        {((part.chars / data.total) * 100).toFixed(1)}%
                      </small>
                    </span>
                  </Button>
                ))}
              </div>
              <p className="muted note">
                单位：字符。JSON 结构开销 {data.envelope}；请求存档共{' '}
                {data.requestChars.toLocaleString()}{' '}
                字符。图片、转义与请求封装不计入七模块占比。
              </p>
              <div className="bench-section-title">
                <strong>{MODULE_LABELS[module]}正文</strong>
                <span className="muted">
                  {selected?.chars.toLocaleString()} 字符
                </span>
              </div>
              <pre className="bench-code">
                {JSON.stringify(selected?.value, null, 2)}
              </pre>
            </>
          ) : (
            <p className="muted">缺少有效的七模块正文，无法计算分布。</p>
          )}
        </TabsContent>
        <TabsContent value="tools">
          <h3>模型提出的工具</h3>
          {benchmarkTools(call).map((tool, index) => (
            <details className="bench-tool" key={index} open>
              <summary className="mono">{tool.name}</summary>
              <pre className="bench-code">{tool.arguments}</pre>
            </details>
          ))}
          {!benchmarkTools(call).length && (
            <p className="muted">未记录工具回复</p>
          )}
          <h3>执行器实际派发 · {commands.length}</h3>
          {commands.map((command, index) => (
            <details className="bench-tool" key={index}>
              <summary>
                <code>
                  {String(command.operation.type)}
                  {command.operation.action
                    ? ` / ${String(command.operation.action)}`
                    : ''}
                </code>
                <span>
                  {command.status} · {command.effect}
                </span>
              </summary>
              {command.fault && (
                <p className="bench-notice">
                  故障注入：{command.fault} · 宿主原始状态{' '}
                  {command.nativeStatus ?? '见回执'}
                </p>
              )}
              <pre className="bench-code">
                {JSON.stringify(command, null, 2)}
              </pre>
            </details>
          ))}
          {!commands.length && (
            <p className="muted">
              本轮没有派发浏览器命令。结算、记录或参数拒绝都可能不产生浏览器命令。
            </p>
          )}
        </TabsContent>
        <TabsContent value="raw">
          <details open>
            <summary>请求 JSON</summary>
            <pre className="bench-code">{call.request ?? '未记录'}</pre>
          </details>
          <details>
            <summary>模型回复</summary>
            <pre className="bench-code">{call.response ?? '未记录'}</pre>
          </details>
        </TabsContent>
      </Tabs>
    </div>
  );
}
