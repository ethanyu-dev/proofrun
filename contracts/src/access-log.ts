/** 登录验证也是一次 HTTP 请求，按独立类别展示，避免重复计数。 */
export type AccessKind = 'console_login' | 'http';

/** 访问元数据不包含凭据、请求正文、查询参数或动态路径参数。 */
export interface AccessRecord {
  /** 数据库顺序身份，以字符串传输以免丢失大整数精度。 */
  id: string;
  /** 请求开始时间，使用服务端时钟。 */
  at: string;
  /** 按受信代理配置解析后的来源地址；无法识别时为空。 */
  ip: string | null;
  /** 控制台连接验证和其他 HTTP 请求的分类。 */
  kind: AccessKind;
  /** 实际请求方法。 */
  method: string;
  /** 匹配的路由模板；未匹配请求不保存原始路径。 */
  route: string;
  /** 实际响应状态，包括鉴权及参数校验失败。 */
  statusCode: number;
  /** 服务端处理耗时，单位为毫秒。 */
  durationMs: number;
}

/** 按入库顺序倒序分页；游标不受新访问插入影响。 */
export interface AccessLogPage {
  /** 当前筛选下的一页访问。 */
  records: AccessRecord[];
  /** 下一页边界，没有更多记录时为空。 */
  nextCursor: string | null;
  /** 服务端保留窗口，供控制台解释可查询范围。 */
  retentionDays: number;
}
