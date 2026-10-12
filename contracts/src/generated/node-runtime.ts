/* 根据 contracts/schemas 自动生成，请勿手改；修改 Schema 后运行 pnpm contracts:generate。 */

/**
 * 节点进程上报的编译身份；用于排查部署版本，不作为授权或能力判断依据。
 */
export interface NodeRuntime {
  /**
   * 完整 release 标签；开发构建带 dev 后缀，不冒充正式安装版本。
   */
  version: string;
  /**
   * 发布源码的完整提交 SHA；本地未注入时为 null。
   */
  sourceCommit: string | null;
  /**
   * 节点启动时核实的 agent-browser 固定版本。
   */
  engineVersion: string;
}
