/** 分析属于请求的一次独立生成，不修改验收事实或触发浏览器重跑。 */
export interface RequestAnalysis {
  /** 每次显式重跑更换代次，迟到回执不能覆盖新分析。 */
  revision: string;
  /** 等待领取、分析中、成功与失败分别展示。 */
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  /** 成功生成的简洁 Markdown；重跑期间保留上一版。 */
  summary: string | null;
  /** 安全错误说明，不包含供应商原始响应。 */
  error: string | null;
  /** 当前生成请求的创建时间。 */
  requestedAt: string;
  /** 上一版成功生成时间，保留内容时保持原时间。 */
  generatedAt: string | null;
  /** 实际分析模型，未生成时为空。 */
  model: string | null;
}

/** Worker 领取独立分析租约，不能用它操作浏览器。 */
export interface AnalysisGrant {
  /** 请求身份与冻结的成员数量。 */
  requestId: string;
  caseCount: number;
  /** 单次领取凭据，不公开给控制台。 */
  token: string;
}

/** 原始记录分片传输，避免整份观察历史超过 HTTP 或模型上下文。 */
export interface AnalysisContextPage {
  /** 当前记录的连续文本；只包含已存档输入、操作决定和结果。 */
  text: string;
  /** 下一片游标；当前 case 所有记录读完后为空。 */
  next: {
    /** 当前 case 内的记录序号；零为报告与步骤定义。 */
    record: number;
    /** 当前序列化记录的字符偏移，连续读取不跳过尾部。 */
    offset: number;
  } | null;
}
