/* 根据 contracts/schemas 自动生成，请勿手改；修改 Schema 后运行 pnpm contracts:generate。 */

export type NotificationEvent = {
  schemaVersion: 'proofrun.notification.v1';
  eventId: string;
  type: 'hitl.requested' | 'hitl.updated' | 'hitl.resolved' | 'hitl.closed' | 'case.finished';
  occurredAt: string;
  integrationId: string;
  bindingRef: string;
  bindingVersion: number;
  caseId: string;
  taskId?: string;
  executionId?: string;
  arm?: 'llm' | 'jev';
  aggregate: {
    kind: 'hitl' | 'case';
    id: string;
    sequence: number;
  };
};
