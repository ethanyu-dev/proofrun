import type { ExecutionView } from '../client.js';
import { AgentFault, pause } from '../http.js';

/** 等待上传只读取控制面，不重发浏览器命令或消耗模型轮数。 */
const POLL_MS = 150;
/** 限制报告长度；只输出平台身份和静态状态，不回显页面或服务错误正文。 */
const MAX_DIAGNOSTICS = 8;
/** 诊断只接受平台标识形态，避免扩展数据携带 URL 或页面正文。 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** 仅回显协议允许的证据类型和持久化阶段。 */
const KINDS = new Set(['DOM', 'SCREENSHOT', 'NETWORK', 'TRACE']);
const STATES = new Set(['PENDING', 'STORED', 'AVAILABLE']);

/** 命令携带的预期证据身份；必须同时匹配控制面类型、摘要和可用状态。 */
interface EvidenceRef {
  /** 节点命令声明的证据 ID，用于关联控制面清单。 */
  artifactId: string;
  /** 类型必须与持久化清单一致，不能跨种类引用。 */
  kind: string;
  /** 摘要必须一致，防止同 ID 的其他内容被误用。 */
  sha256: string;
}

/** 区分尚未登记、等待上传、等待回执和身份不匹配，便于定位交付阶段。 */
function pending(refs: EvidenceRef[], view?: ExecutionView): string[] {
  return refs.flatMap((ref) => {
    const actual = view?.artifacts.find((item) => item.id === ref.artifactId);
    const state = !actual
      ? 'MISSING'
      : actual.kind !== ref.kind || actual.sha256 !== ref.sha256
        ? 'MISMATCH'
        : STATES.has(actual.state)
          ? actual.state
          : 'UNKNOWN';
    if (state === 'AVAILABLE') return [];
    const kind = KINDS.has(ref.kind) ? ref.kind : 'UNKNOWN';
    const id = SAFE_ID.test(ref.artifactId) ? ref.artifactId : 'INVALID_ID';
    return [`${kind} ${id}=${state}`];
  });
}

/** 独立等待持久化及回执；超时也中断在途读取，外部撤权始终优先于局部超时。 */
export async function waitForEvidence(
  refs: EvidenceRef[],
  readView: (signal: AbortSignal) => Promise<ExecutionView>,
  timeoutMs: number,
  stop: AbortSignal,
): Promise<void> {
  stop.throwIfAborted();
  if (!refs.length)
    throw new AgentFault('EVIDENCE_UNAVAILABLE', '节点没有交付证据引用');
  const controller = new AbortController();
  const signal = AbortSignal.any([stop, controller.signal]);
  let view: ExecutionView | undefined;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (;;) {
      signal.throwIfAborted();
      view = await readView(signal);
      // 即使读取晚到，也不能越过任务截止、失租或证据预算继续调用模型。
      signal.throwIfAborted();
      if (view.taskState !== 'RUNNING')
        throw new AgentFault('EXECUTION_ENDED', '控制面已终止任务');
      if (!pending(refs, view).length) return;
      await pause(POLL_MS, signal);
    }
  } catch (error) {
    stop.throwIfAborted();
    if (controller.signal.aborted) {
      const missing = pending(refs, view);
      const details = missing.slice(0, MAX_DIAGNOSTICS).join('；');
      throw new AgentFault(
        'EVIDENCE_UNAVAILABLE',
        `证据交付等待超时（${timeoutMs} 毫秒）；最近状态：${details || '读取已超时'}${missing.length > MAX_DIAGNOSTICS ? `；共 ${missing.length} 项未就绪` : ''}`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
