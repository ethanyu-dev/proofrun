import { analysisModelRequest } from './analysis-model.js';
import type { AnalysisGrant, AnalysisContextPage } from '@proofrun/contracts';
import type { AgentConfig } from './config.js';
import { AgentFault, jsonRequest, pause } from './http.js';
import { reasoningParameters } from './model/reasoning.js';
import { REPORT_ANALYSIS_PROMPT } from './prompts/report-analysis.js';

/** 分析不占浏览器执行槽；租约心跳与模型请求独立，进程关闭可中断两者。 */
const POLL_MS = 5000;
const HEARTBEAT_MS = 15_000;
/** 输入按连续分片处理；笔记超限时失败，不静默截断失败项。 */
const MAX_NOTES_CHARS = 12_000;
const REVIEW_CHARS = 24_000;
const MAX_FINAL_INPUT_CHARS = 100_000;

/** 复用 worker 已配置的文本模型，模型服务配置不会进入控制面或前端。 */
async function summarize(
  config: AgentConfig,
  grant: AnalysisGrant,
  data: { phase: 'review' | 'final'; [key: string]: unknown },
  signal: AbortSignal,
): Promise<string> {
  const reply = (await analysisModelRequest(
    config,
    grant,
    data.phase,
    {
      ...reasoningParameters(config),
      model: config.model,
      stream: false,
      [config.tokenParameter]: config.maxTokens,
      messages: [
        { role: 'system', content: REPORT_ANALYSIS_PROMPT },
        { role: 'user', content: JSON.stringify(data) },
      ],
    },
    signal,
  )) as {
    choices?: Array<{
      finish_reason?: string;
      message?: { content?: unknown };
    }>;
  };
  const choice = reply.choices?.[0];
  const text = choice?.message?.content;
  if (
    choice?.finish_reason === 'length' ||
    typeof text !== 'string' ||
    !text.trim() ||
    text.length > MAX_NOTES_CHARS
  )
    throw new AgentFault('INVALID_ANALYSIS', '分析回复为空、超长或未完成');
  return text.trim();
}

/** 仅遍历待分析 case，但保留其全部分片和前置过程；读取失败不发布局部结论。 */
export async function analyzeReport(
  config: AgentConfig,
  grant: AnalysisGrant,
  signal: AbortSignal,
): Promise<string> {
  const cases: string[] = [];
  // 空集合或旧控制面缺少范围时明确失败，不能把没有异常资料误写成全部通过。
  if (!grant.caseIndices?.length)
    throw new AgentFault('INVALID_ANALYSIS', '缺少待分析的 case');
  for (const caseIndex of grant.caseIndices) {
    let cursor: AnalysisContextPage['next'] = { record: 0, offset: 0 };
    let notes = '';
    let buffer = '';
    do {
      const page: AnalysisContextPage = (await jsonRequest(
        `${config.apiUrl}/v1/analyses/${encodeURIComponent(grant.requestId)}/context?caseIndex=${caseIndex}&record=${cursor.record}&offset=${cursor.offset}`,
        grant.token,
        'GET',
        undefined,
        config.requestMs,
        signal,
      )) as AnalysisContextPage;
      buffer += page.text;
      cursor = page.next;
      if (buffer.length >= REVIEW_CHARS || !cursor) {
        notes = await summarize(
          config,
          grant,
          {
            phase: 'review',
            caseIndex,
            previous: notes,
            text: buffer,
            endOfCase: !cursor,
          },
          signal,
        );
        buffer = '';
      }
    } while (cursor);
    cases.push(notes);
  }
  // 请求过大必须明确失败，不以只总结前几个 case 冒充完整结论。
  if (JSON.stringify(cases).length > MAX_FINAL_INPUT_CHARS)
    throw new AgentFault('ANALYSIS_TOO_LARGE', '请求的复盘笔记超出分析范围');
  return summarize(config, grant, { phase: 'final', cases }, signal);
}

/** 独立后台循环只领取分析任务，不改变 case 调度、执行预算或身份准备。 */
export async function serveReportAnalyses(
  config: AgentConfig,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    try {
      const grant = (await jsonRequest(
        `${config.apiUrl}/v1/worker/analyses/claim`,
        config.workerToken,
        'POST',
        {},
        config.requestMs,
        signal,
      )) as AnalysisGrant | null;
      if (grant) {
        const controller = new AbortController();
        const active = AbortSignal.any([signal, controller.signal]);
        const path = `${config.apiUrl}/v1/analyses/${encodeURIComponent(grant.requestId)}`;
        const heartbeat = (async () => {
          while (!active.aborted) {
            await pause(HEARTBEAT_MS, active);
            await jsonRequest(
              `${path}/heartbeat`,
              grant.token,
              'POST',
              {},
              config.requestMs,
              active,
            );
          }
        })().catch((error: unknown) => {
          if (!active.aborted) controller.abort(error);
        });
        try {
          const summary = await analyzeReport(config, grant, active);
          await jsonRequest(
            `${path}/complete`,
            grant.token,
            'POST',
            { summary, model: config.model },
            config.requestMs,
            active,
          );
        } catch {
          if (!active.aborted)
            await jsonRequest(
              `${path}/complete`,
              grant.token,
              'POST',
              { failed: true },
              config.requestMs,
              active,
            ).catch(() => {});
        } finally {
          controller.abort();
          await heartbeat;
        }
      }
    } catch {
      // 控制面滚动升级或暂时离线时保持浏览器执行循环可用，不输出原始资料。
    }
    await pause(POLL_MS, signal).catch(() => {});
  }
}
