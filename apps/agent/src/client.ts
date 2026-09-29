import { createHash } from 'node:crypto';
import {
  validateExecutionGrant,
  validateNodeEvent,
  type ExecutionGrant,
  type NodeCommand,
  type NodeEvent,
  type VerificationReport,
  type ModelCallWrite,
  type StepResult,
} from '@proofrun/contracts';
import type { AgentConfig } from './config.js';
import {
  AgentFault,
  jsonRequest,
  pause,
  readBytes,
  transient,
} from './http.js';

/** 可确认幂等的请求最多原样重送三次，领取请求不会自动重送。 */
const RETRIES = 3;
/** Node 限制 PNG 为 8 MiB，下载端使用相同边界。 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** 结果轮询只读取数据库，不触发业务动作。 */
const RESULT_POLL_MS = 150;

export type BrowserOperation = Extract<
  NodeCommand['command'],
  { type: 'browser.act' | 'browser.observe' | 'browser.wait' | 'browser.trace' }
>;
export type CommandResult = Extract<NodeEvent, { type: 'command.result' }>;
/** 执行视图只用于生命周期控制；节点和会话身份始终来自领取响应。 */
export interface ExecutionView {
  /** 任务终态用于撤销模型调用，不依赖模型理解取消文本。 */
  taskState: string;
  /** 操作权与代次独立于任务生命周期，暂停期间仍由原 worker 续租。 */
  controlMode: 'AUTO' | 'REQUESTED' | 'HUMAN';
  controlRevision: number;
  actionCount: number;
  /** 浏览器会话就绪和关闭进度。 */
  state: string;
  closureVerified: boolean;
  /** 控制面签发的 worker 权限期限。 */
  leaseExpiresAt: string;
  /** 服务端登记的证据及交付状态，不接受模型自报的 URL。 */
  artifacts: Array<{ id: string; kind: string; sha256: string; state: string }>;
}

/** worker 只连接控制面，从不直接连接浏览器节点或业务内网。 */
export class ControlClient {
  constructor(private readonly config: AgentConfig) {}
  /** 稳定调用身份使正文和回执可原样重送；诊断交付不会触发新的模型请求。 */
  async recordModelCall(
    execution: ExecutionGrant,
    id: string,
    body: ModelCallWrite,
  ): Promise<void> {
    await this.request(
      execution,
      `/model-calls/${encodeURIComponent(id)}`,
      'POST',
      body,
    );
  }
  /** 步骤快照可幂等重送，持久化成功后才允许推进下一步。 */
  async recordSteps(
    execution: ExecutionGrant,
    steps: StepResult[],
  ): Promise<void> {
    await this.request(execution, '/steps', 'POST', steps);
  }
  /** 同一次调用不重试 claim：回执丢失时由短租约回收，不冒险重复领取。 */
  async claim(signal?: AbortSignal): Promise<ExecutionGrant | null> {
    const response = (await jsonRequest(
      `${this.config.apiUrl}/v1/worker/claim`,
      this.config.workerToken,
      'POST',
      {
        type: 'worker.claim',
        workerId: this.config.workerId,
        structuredSteps: true,
      },
      this.config.requestMs,
      signal,
    )) as { execution?: unknown };
    if (response?.execution === null) return null;
    if (!validateExecutionGrant(response?.execution))
      throw new AgentFault('INVALID_GRANT', '控制面返回的执行授权不完整');
    return response.execution;
  }
  /** 只用于幂等的读取、同 ID 命令与不可变完成报告。 */
  private async request(
    execution: ExecutionGrant,
    path: string,
    method: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await jsonRequest(
          `${this.config.apiUrl}/v1/executions/${execution.id}${path}`,
          execution.leaseToken,
          method,
          body,
          this.config.requestMs,
          signal,
        );
      } catch (error) {
        if (!transient(error) || attempt + 1 >= RETRIES) throw error;
        await pause(100 * (attempt + 1), signal);
      }
    }
  }
  /** 历史证据与状态在执行终止后仍可读，不能据此获取新执行权限。 */
  async view(
    execution: ExecutionGrant,
    signal?: AbortSignal,
  ): Promise<ExecutionView> {
    const view = (await this.request(
      execution,
      '',
      'GET',
      undefined,
      signal,
    )) as ExecutionView;
    if (
      !view ||
      typeof view.taskState !== 'string' ||
      typeof view.state !== 'string' ||
      !Array.isArray(view.artifacts) ||
      !Number.isFinite(Date.parse(view.leaseExpiresAt))
    )
      throw new AgentFault('INVALID_EXECUTION_VIEW', '执行状态回复无效');
    return view;
  }
  /** 独立于模型调用续期；一旦失效，控制面不会复活旧租约。 */
  async heartbeat(
    execution: ExecutionGrant,
    signal: AbortSignal,
  ): Promise<string> {
    const value = (await this.request(
      execution,
      '/heartbeat',
      'POST',
      undefined,
      signal,
    )) as { leaseExpiresAt: string };
    if (!value || !Number.isFinite(Date.parse(value.leaseExpiresAt)))
      throw new AgentFault('INVALID_LEASE', '续租回复无效');
    return value.leaseExpiresAt;
  }
  /** 同一命令在所有重送中保持完整内容不变，绝不换 ID 重试不确定写入。 */
  async command(
    execution: ExecutionGrant,
    commandId: string,
    operation: BrowserOperation,
    timeoutMs: number,
    signal: AbortSignal,
    controlRevision = 0,
  ): Promise<CommandResult> {
    const request = {
      type: 'execution.command',
      controlRevision,
      commandId,
      timeoutMs,
      command: operation,
    };
    let result: unknown;
    try {
      const initial = (await this.request(
        execution,
        '/commands',
        'POST',
        request,
        signal,
      )) as { result: unknown };
      result = initial?.result;
      const deadline = performance.now() + timeoutMs + this.config.requestMs;
      while (!result) {
        if (performance.now() >= deadline)
          throw new AgentFault(
            'COMMAND_RESULT_UNKNOWN',
            '命令结果未能在预算内确认，不继续操作',
          );
        await pause(RESULT_POLL_MS, signal);
        result = (
          (await this.request(
            execution,
            `/commands/${commandId}`,
            'GET',
            undefined,
            signal,
          )) as { result: unknown }
        ).result;
      }
    } catch (error) {
      if (!signal.aborted) throw error;
      // 未知写入可能先触发撤权，再到达结果轮询；最后只读一次已持久化结果。
      // 不使用失效信号，但保留单次 HTTP 时限，不重发命令或恢复执行权。
      const receipt = (await jsonRequest(
        `${this.config.apiUrl}/v1/executions/${execution.id}/commands/${commandId}`,
        execution.leaseToken,
        'GET',
        undefined,
        this.config.requestMs,
      ).catch(() => null)) as { result?: unknown } | null;
      if (!receipt?.result) throw error;
      result = receipt.result;
    }
    if (
      !validateNodeEvent(result) ||
      result.type !== 'command.result' ||
      result.commandId !== commandId ||
      result.sessionId !== execution.sessionId ||
      result.nodeId !== execution.nodeId
    )
      throw new AgentFault('INVALID_COMMAND_RESULT', '命令结果归属不匹配');
    return result;
  }
  /** 完成报告幂等重送；不让续租停止引起的 AbortSignal 打断已提交报告确认。 */
  async complete(
    execution: ExecutionGrant,
    report: VerificationReport,
    controlRevision = 0,
  ): Promise<void> {
    await this.request(execution, '/complete', 'POST', {
      type: 'execution.complete',
      controlRevision,
      report,
    });
  }
  /** 人工控制请求带代次，可安全确认相同请求，不能跨代次自动重复接管。 */
  async intervene(
    execution: ExecutionGrant,
    controlRevision: number,
    reason: string,
    signal: AbortSignal,
    items?: string[],
  ): Promise<void> {
    await this.request(
      execution,
      '/intervene',
      'POST',
      {
        type: 'execution.intervene',
        controlRevision,
        reason,
        ...(items ? { items } : {}),
      },
      signal,
    );
  }
  /** 只有执行循环到达无在途动作的检查点，才把浏览器交给人工。 */
  async acknowledge(
    execution: ExecutionGrant,
    controlRevision: number,
    signal: AbortSignal,
  ): Promise<void> {
    await this.request(
      execution,
      '/control',
      'POST',
      { type: 'execution.control', action: 'acknowledge', controlRevision },
      signal,
    );
  }
  /** 截图按本次执行读取并核对摘要，不能向模型服务传递带平台密钥的下载地址。 */
  async image(
    execution: ExecutionGrant,
    artifact: { id: string; sha256: string },
    signal: AbortSignal,
  ): Promise<string> {
    const response = await fetch(
      `${this.config.apiUrl}/v1/executions/${execution.id}/artifacts/${encodeURIComponent(artifact.id)}`,
      {
        redirect: 'error',
        headers: { authorization: `Bearer ${execution.leaseToken}` },
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(this.config.requestMs),
        ]),
      },
    );
    if (!response.ok)
      throw new AgentFault(
        'EVIDENCE_UNAVAILABLE',
        '截图尚不可读取',
        response.status,
      );
    const bytes = await readBytes(response, MAX_IMAGE_BYTES);
    if (
      createHash('sha256').update(bytes).digest('hex') !== artifact.sha256 ||
      !bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      throw new AgentFault('EVIDENCE_MISMATCH', '截图内容与已登记证据不符');
    return `data:image/png;base64,${bytes.toString('base64')}`;
  }
}
