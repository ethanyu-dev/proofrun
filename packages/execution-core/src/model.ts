import type {
  AgentDecision,
  ModelCall,
  ModelCallWrite,
} from '@proofrun/contracts';
import type { DecisionContextData } from './execution/context.js';
import type { NetworkReadDecision } from './evidence/network-reads.js';
/** 模型上下文由执行器根据事实重建，不保存不断增长的聊天历史。 */
export interface DecisionInput {
  /** 服务端决定帧的稳定审计身份；旧 worker 路径由执行器生成随机身份。 */
  traceId?: string;
  /** 正文在实际请求前保存，返回的回执函数补交该次供应商回复或稳定错误码。 */
  traceRequest?: (
    request: Pick<
      ModelCall,
      | 'model'
      | 'purpose'
      | 'request'
      | 'requestSha256'
      | 'imagesOmitted'
      | 'timeoutMs'
    >,
  ) => Promise<
    (
      result: Extract<ModelCallWrite, { phase: 'finish' }>['result'],
    ) => Promise<void>
  >;
  /** 每次真实 HTTP 模型请求前扣预算。 */
  recordRequest?: (model: string) => void;
  /** 只登记服务实际返回的用量，异常或缺失 usage 不推算。 */
  recordUsage?: (model: string, input: number, output: number) => void;
  /** 有界 JSON 文本，包括固定标准、最新观察、近期操作与可引用证据。 */
  text: string;
  /** 本轮模型派发的单调时钟截止点，不能占用原预算内预留的收尾时间。 */
  modelDeadline?: number;
  /** 同一裁剪快照的类型化副本；旧调用端只提供 text 时仍兼容。 */
  context?: DecisionContextData;
  /** 可选的一张当前截图，已经核实归属、格式与 SHA-256。 */
  image?: string;
}
/** 一次模型调用的结构化结果，token 数仅来自服务回复。 */
export interface DecisionOutput {
  decision: AgentDecision;
  /** 同一真实模型回复中的其余纯网络读取，执行器整批校验后本地处理。 */
  additionalNetworkReads?: NetworkReadDecision[];
  promptTokens: number;
  completionTokens: number;
}
/** 类型化快照是唯一输入；旧调用端只有文本时在边界解析一次。 */
export function decisionData(input: DecisionInput): DecisionContextData {
  return input.context ?? JSON.parse(input.text);
}
/** 执行循环只依赖此接口，供应商细节限制在单个适配器中。 */
export interface DecisionModel {
  /** 有跨轮状态的适配器必须为每个 tab 创建独立实例；无状态适配器可直接复用。 */
  fork?(): DecisionModel;
  decide(input: DecisionInput, signal: AbortSignal): Promise<DecisionOutput>;
}
