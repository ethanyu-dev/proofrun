/* 根据 contracts/schemas 自动生成，请勿手改；修改 Schema 后运行 pnpm contracts:generate。 */

/**
 * 浏览器任务只接收业务输入和客户端生成的稳定重试身份；执行配置由服务端冻结。
 */
export interface BrowserTaskRequest {
  /**
   * 客户端生成的稳定身份；相同身份只接受相同业务输入，失败重试必须复用。
   */
  taskId: string;
  /**
   * 浏览器首次访问的 HTTP(S) 入口，不隐含最终地址约束。
   */
  url: string;
  /**
   * 完整保留用户要求的操作、查询和交付内容；不推导额外验收项。
   */
  objective: string;
}
