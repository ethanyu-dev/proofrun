import { createHash } from 'node:crypto';
import type { ModelCall } from '@proofrun/contracts';
import type { DecisionInput } from './chat.js';
import { AgentFault } from '../http.js';

/** 回复只保留供应商决定与用量字段，不保存传输头、认证配置或供应商诊断附属数据。 */
const RESPONSE_FIELDS = ['choices', 'answers', 'usage'] as const;
/** 只传播稳定错误码，禁止把底层异常正文、URL 或凭据带入报告。 */
const ERROR_CODE = /^[A-Z_]{1,80}$/;

/** 从供应商用量中读取已报告的安全整数；缺失值不伪造为真实零用量。 */
function tokens(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

/** 记录一次真实 HTTP 请求，包括混合策略子调用；图片原文改为可核查的截图引用。 */
export async function modelRequest(
  input: DecisionInput,
  model: string,
  purpose: ModelCall['purpose'],
  body: Record<string, unknown>,
  send: () => Promise<unknown>,
): Promise<unknown> {
  // 原始摘要对应实际派发正文；展示副本中的图片只替换 base64，不改变模型收到的内容。
  const raw = JSON.stringify(body);
  let imagesOmitted = 0;
  let context: { observation?: { artifactRefs?: unknown[] } } = {};
  try {
    context = JSON.parse(input.text);
  } catch {
    /* 填写子请求不要求通用上下文。 */
  }
  const request = JSON.stringify(body, (key, value) => {
    if (
      key === 'image_url' &&
      value &&
      typeof value.url === 'string' &&
      value.url.startsWith('data:image/')
    ) {
      imagesOmitted++;
      return {
        evidenceRefs: context.observation?.artifactRefs ?? [],
        omitted: '图片通过已有证据查看',
      };
    }
    return value;
  });
  const receipt = await input.traceRequest?.({
    model,
    purpose,
    request,
    requestSha256: createHash('sha256').update(raw).digest('hex'),
    imagesOmitted,
  });
  input.recordRequest?.(model);
  const started = performance.now();
  let result: unknown;
  try {
    result = await send();
  } catch (error) {
    await receipt?.({
      finishedAt: new Date().toISOString(),
      status: 'ERROR',
      response: null,
      error: error instanceof AgentFault ? error.code : 'REQUEST_ABORTED',
      promptTokens: null,
      completionTokens: null,
      elapsedMs: Math.round(performance.now() - started),
    });
    throw error;
  }
  const reply = result as { usage?: Record<string, unknown> } | null;
  const usage = reply?.usage;
  const promptTokens = tokens(usage?.prompt_tokens ?? usage?.input_tokens);
  const completionTokens = tokens(
    usage?.completion_tokens ?? usage?.output_tokens,
  );
  // 格式错误的回复也已发生真实调用，解析前先登记用量。
  input.recordUsage?.(model, promptTokens ?? 0, completionTokens ?? 0);
  const selected = Object.fromEntries(
    RESPONSE_FIELDS.filter(
      (key) => result && typeof result === 'object' && key in result,
    ).map((key) => [key, (result as Record<string, unknown>)[key]]),
  );
  await receipt?.({
    finishedAt: new Date().toISOString(),
    status: 'RECEIVED',
    response: JSON.stringify(selected),
    error: null,
    promptTokens,
    completionTokens,
    elapsedMs: Math.round(performance.now() - started),
  });
  return result;
}

/** 存档失败继续阻止派发，仅补充可安全展示的 HTTP 状态与稳定错误码。 */
export function modelTraceFault(
  error: unknown,
  phase: 'start' | 'finish',
): AgentFault {
  const details: string[] = [];
  if (error instanceof AgentFault) {
    if (
      Number.isInteger(error.status) &&
      error.status >= 400 &&
      error.status <= 599
    )
      details.push(`HTTP ${error.status}`);
    if (ERROR_CODE.test(error.code)) details.push(error.code);
  }
  const message =
    phase === 'start'
      ? '模型请求上下文未能存档，停止派发新请求'
      : '模型回复未能存档，请检查该次调用记录';
  return new AgentFault(
    'MODEL_TRACE_UNAVAILABLE',
    `${message}${details.length ? `（${details.join('；')}）` : ''}`,
  );
}
