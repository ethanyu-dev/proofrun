import type { IntegrationSubmit } from '@proofrun/contracts';
import { validateIntegrationSubmit } from '@proofrun/contracts';
import type { Database } from '../../db.js';
import { ApiError, canonical, digest } from '../../domain.js';
import type { CaseV2Service } from '../cases/v2.js';
import type { IntegrationClient, IntegrationConfig } from './config.js';
import type { CaseBindingContext, CaseBindingWrite } from './binding.js';
import { remote } from './remote.js';

/** 集成归属、幂等请求和通知绑定的应用入口；不控制浏览器或代替人工决策。 */
export class IntegrationService {
  constructor(
    private readonly db: Database,
    private readonly cases: CaseV2Service,
    private readonly config: IntegrationConfig,
  ) {}

  /** 准入就绪是远端绑定当前状态的只读快照，不证明模型或业务页面可用。 */
  async readiness(client: IntegrationClient) {
    const connection = this.config.connections.find(
      (item) => item.id === client.integrationId,
    )!;
    return Promise.all(
      client.bindingRefs.map(async (ref) => {
        const binding = connection.bindings.find((item) => item.ref === ref)!;
        let ready = false;
        try {
          const value: any = await remote(
            connection,
            `/integrations/v1/proofrun/bindings/${encodeURIComponent(ref)}?version=${binding.version}`,
          );
          ready =
            value?.integrationId === connection.id &&
            value.bindingRef === ref &&
            value.bindingVersion === binding.version &&
            value.enabled === true &&
            value.botReady === true;
        } catch {
          /* 独立返回不可用，能力查询本身不因此失败。 */
        }
        return { bindingRef: ref, version: binding.version, ready };
      }),
    );
  }

  /** 先验证调用者归属，避免把存在性或证据暴露给另一 MCP 客户端。 */
  async owned(
    client: IntegrationClient,
    caseId: string,
  ): Promise<CaseBindingContext> {
    const row = (
      await this.db.query(
        'SELECT context FROM pr_integration_cases WHERE case_id=$1 AND client_id=$2',
        [caseId, client.id],
      )
    ).rows[0];
    if (!row)
      throw new ApiError(404, 'CASE_MISSING', 'Case not found for this client');
    return row.context;
  }

  /** 新 case 才访问远端绑定；重提先恢复原快照，因此 cc-connect 离线不影响幂等结果。 */
  private async binding(
    client: IntegrationClient,
    input: IntegrationSubmit,
  ): Promise<CaseBindingWrite> {
    const existing = (
      await this.db.query(
        'SELECT client_id,context FROM pr_integration_cases WHERE case_id=$1',
        [input.case.caseId],
      )
    ).rows[0];
    if (existing) {
      if (existing.client_id !== client.id)
        throw new ApiError(
          409,
          'CASE_BINDING_CONFLICT',
          'Case 已绑定另一调用者',
        );
      const context = existing.context as CaseBindingContext;
      if (
        context.definitionDigest !== digest(canonical(input.case)) ||
        canonical(context.source) !== canonical(input.source) ||
        (input.notification &&
          input.notification.bindingRef !== context.bindingRef) ||
        (input.notification?.events &&
          canonical([...input.notification.events].sort()) !==
            canonical(context.events))
      )
        throw new ApiError(
          409,
          'CASE_BINDING_CONFLICT',
          'Case 定义、来源或通知绑定发生变化',
        );
      return { clientId: client.id, context, deduplicated: true };
    }
    const bindingRef =
      input.notification?.bindingRef ?? client.defaultBindingRef;
    const connection = this.config.connections.find(
      (item) => item.id === client.integrationId,
    )!;
    const binding = connection.bindings.find((item) => item.ref === bindingRef);
    if (!binding || !client.bindingRefs.includes(bindingRef))
      throw new ApiError(
        403,
        'BINDING_FORBIDDEN',
        '调用者不允许使用该通知绑定',
      );
    let remoteBinding: any;
    try {
      remoteBinding = await remote(
        connection,
        `/integrations/v1/proofrun/bindings/${encodeURIComponent(bindingRef)}?version=${binding.version}`,
      );
    } catch {
      throw new ApiError(503, 'BINDING_UNAVAILABLE', '通知绑定服务暂不可用');
    }
    if (
      remoteBinding?.integrationId !== connection.id ||
      remoteBinding.bindingRef !== bindingRef ||
      remoteBinding.bindingVersion !== binding.version ||
      remoteBinding.enabled !== true ||
      remoteBinding.botReady !== true
    )
      throw new ApiError(
        503,
        'BINDING_NOT_READY',
        '通知绑定版本或机器人状态未就绪',
      );
    return {
      clientId: client.id,
      deduplicated: false,
      context: {
        integrationId: connection.id,
        bindingRef,
        bindingVersion: binding.version,
        events: [
          ...(input.notification?.events ?? ['hitl']),
        ].sort() as CaseBindingContext['events'],
        ...(input.source ? { source: input.source } : {}),
        definitionDigest: digest(canonical(input.case)),
      },
    };
  }

  /** 单 case 快速接收；真正的冲突检查仍在任务事务锁内执行。 */
  async submit(client: IntegrationClient, input: unknown) {
    if (!validateIntegrationSubmit(input))
      throw new ApiError(400, 'INVALID_REQUEST', '提交不符合集成契约');
    const binding = await this.binding(client, input);
    const [result] = await this.cases.submit([input.case], binding);
    return {
      accepted: true,
      deduplicated: binding.deduplicated,
      caseId: input.case.caseId,
      definitionDigest: binding.context.definitionDigest,
      bindingRef: binding.context.bindingRef,
      result: result!,
    };
  }

  /** 返回真实执行结果与投递状态；不返回持有即可操作的 HITL 链接。 */
  async get(client: IntegrationClient, caseId: string) {
    await this.owned(client, caseId);
    const result = await this.cases.get(caseId);
    const interventions = (
      await this.db.query(
        `SELECT id AS "hitlRequestId",sequence,snapshot->>'state' AS state,snapshot->'items' AS items,snapshot->>'reason' AS reason,snapshot->>'taskId' AS "taskId",snapshot->>'executionId' AS "executionId" FROM pr_notification_aggregates WHERE case_id=$1 AND kind='hitl' ORDER BY id`,
        [caseId],
      )
    ).rows;
    const notificationDeliveries = (
      await this.db.query(
        `SELECT o.event_id AS "eventId",o.sequence,o.status,o.attempts,o.next_attempt_at AS "nextAttemptAt",o.last_error AS error,o.receipt FROM pr_notification_outbox o JOIN pr_notification_aggregates a ON a.id=o.aggregate_id WHERE a.case_id=$1 ORDER BY o.created_at,o.sequence`,
        [caseId],
      )
    ).rows;
    return { result, interventions, notificationDeliveries };
  }

  /** 取消复用已有整例取消入口；通知由状态事务生成。 */
  async cancel(client: IntegrationClient, caseId: string) {
    await this.owned(client, caseId);
    return this.cases.cancel(caseId);
  }

  /** 重跑复用环境和原通知绑定；新 case 不因今天的默认群变化而改发。 */
  async rerun(
    client: IntegrationClient,
    caseId: string,
    newCaseId: string,
    budgetMode: 'current' | 'original' = 'current',
  ) {
    const original = await this.owned(client, caseId);
    const row = (
      await this.db.query(
        'SELECT t.definition FROM pr_tasks t JOIN pr_integration_cases b ON b.task_id=t.id WHERE b.case_id=$1',
        [caseId],
      )
    ).rows[0]!;
    const input = { ...row.definition.caseV2Definition, caseId: newCaseId };
    const binding = {
      clientId: client.id,
      deduplicated: false,
      context: { ...original, definitionDigest: digest(canonical(input)) },
    };
    // 新运行仍核验冻结的远端绑定版本，但不改用配置中的新默认值。
    const existing = (
      await this.db.query(
        'SELECT case_id FROM pr_integration_cases WHERE case_id=$1',
        [newCaseId],
      )
    ).rowCount;
    if (!existing) {
      const connection = this.config.connections.find(
        (item) => item.id === original.integrationId,
      );
      if (!connection)
        throw new ApiError(503, 'BINDING_UNAVAILABLE', '原集成连接不可用');
      let target: any;
      try {
        target = await remote(
          connection,
          `/integrations/v1/proofrun/bindings/${encodeURIComponent(original.bindingRef)}?version=${original.bindingVersion}`,
        );
      } catch {
        throw new ApiError(503, 'BINDING_UNAVAILABLE', '通知绑定服务暂不可用');
      }
      if (
        target?.integrationId !== original.integrationId ||
        target.bindingRef !== original.bindingRef ||
        target.bindingVersion !== original.bindingVersion ||
        !target.enabled ||
        !target.botReady
      )
        throw new ApiError(503, 'BINDING_NOT_READY', '原通知绑定未就绪');
    }
    return this.cases.rerun(caseId, newCaseId, budgetMode, binding);
  }
}
