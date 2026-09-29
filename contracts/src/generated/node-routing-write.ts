/* 根据 contracts/schemas 自动生成，请勿手改；修改 Schema 后运行 pnpm contracts:generate。 */

/**
 * 节点域名绑定的完整替换；空列表解除绑定，版本防止覆盖他人修改。
 */
export interface NodeRoutingWrite {
  /**
   * 完整域名精确匹配；同一资源池内唯一。
   *
   * @maxItems 100
   */
  domains: string[];
  /**
   * 读取节点时得到的配置版本。
   */
  revision: number;
}
