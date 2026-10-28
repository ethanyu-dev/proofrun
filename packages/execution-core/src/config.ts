/** 执行编排仅依赖非秘密策略；模型地址、密钥与提示词由 worker 保留。 */
export interface ExecutionConfig {
  /** 仅用于生成证据引用，不用于选择网络目标。 */
  apiUrl: string;
  /** 模型标识用于执行用量归属。 */
  model: string;
  /** 允许模型使用经校验的当前截图。 */
  vision: boolean;
  /** 浏览器命令与证据交付的独立上限。 */
  commandMs: number;
  evidenceMs: number;
  /** 旧任务总轮数与每轮上下文限额，不能扩大冻结步骤预算。 */
  maxTurns: number;
  maxContextChars: number;
}
