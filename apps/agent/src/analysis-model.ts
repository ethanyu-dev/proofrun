import { randomUUID } from 'node:crypto';
import type { AnalysisGrant, AnalysisCallWrite } from '@proofrun/contracts';
import type { AgentConfig } from './config.js';
import { AgentFault, jsonRequest, pause } from './http.js';

/** 用量登记重送复用调用身份，不能因此重发模型请求。 */
const RECEIPT_ATTEMPTS = 3;
const RECEIPT_TIMEOUT_MS = 10_000;
const ERROR_CODE = /^[A-Z_]{1,80}$/;

/** 缺失 usage 保持 null；仅采集供应商实际报告的安全整数。 */
function tokens(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

/** 元数据日志可按请求和调用身份检索，不输出提示词、观察、响应正文或认证信息。 */
function log(
  requestId: string,
  callId: string,
  fields: Record<string, unknown>,
) {
  console.info(
    JSON.stringify({
      event: 'report_analysis_model',
      requestId,
      callId,
      ...fields,
    }),
  );
}

/** 每次复盘和最终总结都单独登记；收到无效格式的回复也先记录已发生消耗。 */
export async function analysisModelRequest(
  config: AgentConfig,
  grant: AnalysisGrant,
  stage: 'review' | 'final',
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const callId = randomUUID();
  const path = `${config.apiUrl}/v1/analyses/${encodeURIComponent(grant.requestId)}/model-calls/${callId}`;
  const record = async (
    value: AnalysisCallWrite,
    receiptSignal: AbortSignal,
  ) => {
    for (let attempt = 0; ; attempt++) {
      try {
        await jsonRequest(
          path,
          grant.token,
          'POST',
          value,
          Math.min(config.requestMs, RECEIPT_TIMEOUT_MS),
          receiptSignal,
        );
        return;
      } catch (error) {
        if (
          receiptSignal.aborted ||
          attempt + 1 >= RECEIPT_ATTEMPTS ||
          (error instanceof AgentFault &&
            error.status >= 400 &&
            error.status < 500)
        )
          throw error;
        await pause(200 * (attempt + 1), receiptSignal);
      }
    }
  };
  await record({ phase: 'start', stage, model: config.model }, signal);
  log(grant.requestId, callId, {
    stage,
    model: config.model,
    status: 'PENDING',
  });
  const started = performance.now();
  let reply: unknown;
  let failure: unknown;
  let failed = false;
  try {
    reply = await jsonRequest(
      `${config.modelUrl}/chat/completions`,
      config.modelKey,
      'POST',
      body,
      config.modelMs,
      signal,
    );
  } catch (error) {
    failed = true;
    failure = error;
  }
  const usage = (reply as { usage?: Record<string, unknown> } | null)?.usage;
  const result: AnalysisCallWrite = {
    phase: 'finish',
    status: failed ? 'ERROR' : 'RECEIVED',
    promptTokens: failed
      ? null
      : tokens(usage?.prompt_tokens ?? usage?.input_tokens),
    completionTokens: failed
      ? null
      : tokens(usage?.completion_tokens ?? usage?.output_tokens),
    elapsedMs: Math.round(performance.now() - started),
    error: failed
      ? failure instanceof AgentFault && ERROR_CODE.test(failure.code)
        ? failure.code
        : 'REQUEST_ABORTED'
      : null,
  };
  log(grant.requestId, callId, { stage, model: config.model, ...result });
  // 停止或租约更换后仍允许有界回写原调用；服务端不让回执覆盖新一代总结。
  try {
    await record(result, AbortSignal.timeout(RECEIPT_TIMEOUT_MS));
  } catch {
    log(grant.requestId, callId, { stage, status: 'RECEIPT_FAILED' });
    throw new AgentFault(
      'ANALYSIS_USAGE_UNAVAILABLE',
      '分析用量回执未确认，停止后续调用',
    );
  }
  if (failed) throw failure;
  return reply;
}
