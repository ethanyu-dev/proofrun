/* 根据 contracts/schemas 自动生成，请勿手改；修改 Schema 后运行 pnpm contracts:generate。 */

/**
 * 最近一次领取检查发现的排队原因；不包含节点身份或登录凭据，也不是业务验收结论。
 */
export interface QueueReason {
  code:
    | 'CLEANUP_PARENT_PENDING'
    | 'CLEANUP_PARENT_MISSING'
    | 'CLEANUP_NODE_CONFLICT'
    | 'AUTH_NODE_ROUTE_CONFLICT'
    | 'COMPARISON_NODE_CONFLICT'
    | 'RESOURCE_BUSY'
    | 'NO_ELIGIBLE_NODE'
    | 'NODE_CAPACITY'
    | 'NODE_ROTATING'
    | 'SESSION_BUDGET_UNSUPPORTED';
  message: string;
}
