import type { PoolClient } from 'pg';
import {
  sessionBudgetMs,
  validateMcpArguments,
  validateMcpTaskResult,
  type McpTaskCall,
  type VerificationTask,
} from '@proofrun/contracts';
import type { ApiConfig } from '../../config.js';
import type { Database } from '../../db.js';
import { ApiError, canonical, digest } from '../../domain.js';
import type { CaseV2Service } from '../cases/v2.js';
import type { Coordinator } from '../scheduling/coordinator.js';
import type { RequestReader } from '../requests/reader.js';
import { requestIdentity } from '../requests/service.js';
import { PublicViews, requestRevision } from './views.js';
import { PublicEvidence } from './evidence.js';
import { transactionDefinitions } from './definitions.js';
import {
  bindOwned,
  checkBinding,
  lockPublic,
  publicCall,
  requireOwned,
  type ResourceRef,
  type PublicQuery,
} from './ledger.js';
import type { ArtifactStore } from '../reports/artifacts.js';
import type { PublicCredential, PublicScope, PublicChannel } from './auth.js';

/** 预检和工具错误使用字段路径，不回显原始输入或身份材料。 */
export class PublicInputError extends ApiError {
  constructor(readonly details: Array<{ path: string; message: string }>) {
    super(400, 'INVALID_INPUT', '工具参数不符合当前接入契约');
  }
}
/** 工具权限表同时驱动发现和调用，不能靠隐藏工具代替授权。 */
export function toolScope(name: string): PublicScope | undefined {
  if (name.endsWith('get_capabilities')) return undefined;
  if (name.includes('evidence')) return 'evidence:read';
  if (name.includes('cancel')) return 'runs:cancel';
  if (name === 'browser_task_submit') return 'browser:delegate';
  if (
    [
      'verification_submit_cases',
      'verification_validate_cases',
      'verification_rerun_cases',
    ].includes(name)
  )
    return 'verification:submit';
  return 'runs:read';
}
/** HTTP 与 MCP 的唯一业务适配层；没有节点操作或额外模型调用。 */
export class PublicTaskService {
  readonly views: PublicViews;
  readonly evidence: PublicEvidence;
  constructor(
    private readonly db: Database,
    private readonly config: ApiConfig,
    private readonly cases: CaseV2Service,
    private readonly coordinator: Coordinator,
    private readonly requests: RequestReader,
    artifacts: ArtifactStore,
  ) {
    this.views = new PublicViews(db, requests, config.publicUrl);
    this.evidence = new PublicEvidence(db, artifacts, config.publicUrl);
  }

  /** 共享 HTTP 路径根据已授权运行决定工具目录，不能由客户端伪造任务种类。 */
  async channelForRun(
    principal: string,
    runId: string,
  ): Promise<PublicChannel> {
    await requireOwned(this.db, principal, { kind: 'run', id: runId });
    const row = (
      await this.db.query('SELECT definition FROM pr_tasks WHERE id=$1', [
        runId,
      ])
    ).rows[0];
    if (!row) throw new ApiError(410, 'RESOURCE_DELETED', '资源已删除');
    return row.definition.taskKind === 'browser' ? 'browser' : 'verification';
  }

  /** 入口先鉴权再解析参数，不能从任意工具名进入另一个目录。 */
  async execute(
    principal: PublicCredential,
    channel: PublicChannel,
    name: string,
    input: unknown,
  ): Promise<Record<string, unknown>> {
    if (!name.startsWith(`${channel}_`) || !validateMcpArguments.has(name))
      throw new ApiError(404, 'TOOL_NOT_FOUND', '工具不存在');
    const scope = toolScope(name);
    if (scope && !principal.scopes.includes(scope))
      throw new ApiError(403, 'SCOPE_FORBIDDEN', '凭据未授权此工具');
    const validate = validateMcpArguments.get(name)!;
    if (!validate(input)) {
      const details = (validate.errors ?? []).slice(0, 100).map((error) => ({
        path: error.instancePath,
        message: error.message ?? '参数无效',
      }));
      if (name === 'verification_validate_cases')
        return {
          kind: 'validation',
          data: {
            valid: false,
            errors: details,
            warnings: [],
            definitionDigest: digest(canonical(input)),
            executionPreview: [],
            unchecked: ['实际环境未检查'],
          },
        };
      throw new PublicInputError(details);
    }
    if (
      ['verification_submit_cases', 'verification_validate_cases'].includes(
        name,
      ) &&
      input &&
      typeof input === 'object' &&
      'executor' in input &&
      (input.executor as { kind?: string })?.kind === 'external' &&
      !principal.scopes.includes('verification:control')
    )
      throw new ApiError(
        403,
        'SCOPE_FORBIDDEN',
        '外部验证提交需要 verification:control',
      );
    const result = await this.dispatch(principal.principalId, {
      name,
      arguments: input,
    } as McpTaskCall);
    if (!validateMcpTaskResult(result))
      throw new ApiError(
        503,
        'INVALID_PUBLIC_RESULT',
        '服务端结果不符合公共契约',
      );
    return result;
  }

  private async dispatch(
    principal: string,
    call: McpTaskCall,
  ): Promise<Record<string, unknown>> {
    switch (call.name) {
      case 'browser_get_capabilities':
        if (call.arguments.runId)
          await requireOwned(this.db, principal, {
            kind: 'run',
            id: call.arguments.runId,
          });
        return this.capabilities('browser');
      case 'verification_get_capabilities':
        return this.capabilities('verification');
      case 'browser_task_submit':
        return this.submitBrowser(principal, call.arguments);
      case 'verification_validate_cases':
        return this.validate(principal, call.arguments);
      case 'verification_submit_cases':
        return this.submitCases(principal, call.arguments);
      case 'browser_task_get':
        return this.views.run(principal, call.arguments, 'browser');
      case 'verification_get_run':
        return this.views.run(principal, call.arguments, 'verification');
      case 'verification_get_request':
        return this.views.request(principal, call.arguments);
      case 'browser_task_cancel':
        return this.cancel(principal, call.name, call.arguments, 'browser');
      case 'verification_cancel_run':
        return this.cancel(
          principal,
          call.name,
          call.arguments,
          'verification',
        );
      case 'verification_rerun_cases':
        return this.rerun(principal, call.arguments);
      case 'browser_evidence_read':
      case 'verification_read_evidence':
        return this.evidence.read(principal, call.arguments);
      case 'browser_operation_get':
      case 'verification_operation_get': {
        const row = (
          await this.db.query(
            "SELECT result,resources FROM pr_public_calls WHERE principal_id=$1 AND namespace='operation' AND call_key=$2",
            [principal, call.arguments.operationId],
          )
        ).rows[0];
        if (!row)
          throw new ApiError(404, 'RESOURCE_NOT_FOUND', '操作不存在或不可访问');
        for (const resource of row.resources as ResourceRef[])
          await requireOwned(this.db, principal, resource);
        return row.result;
      }
    }
  }

  /** 部署配置与实际可用性分开返回，健康探针不能证明模型、账号或目标可达。 */
  private capabilities(kind: PublicChannel) {
    const configured = kind === 'browser' || !!this.config.caseProfile;
    return {
      kind: 'capabilities',
      data: {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        supportedTaskKinds: [kind],
        supportedExecutors: ['builtin', 'external'],
        capabilities: [
          {
            id: 'task.delegate',
            implemented: true,
            availability: configured ? 'unknown' : 'unavailable',
            reasonCodes: configured
              ? ['WORKER_MODEL_NOT_PROBED']
              : ['CASE_NOT_CONFIGURED'],
            source: 'deployment_config',
            checkedAt: new Date().toISOString(),
          },
          {
            id: 'execution.external',
            implemented: true,
            availability: configured ? 'unknown' : 'unavailable',
            reasonCodes: ['PUBLIC_HTTP_API', 'NODE_NOT_RESERVED'],
            constraints: [
              '直接执行使用两套 MCP 操作工具或 /v3 控制 API；复用同一权限和幂等账本',
              '外部组串行；模型用量不可观测',
            ],
          },
          {
            id: 'browser.identity_override',
            implemented: false,
            availability: 'unavailable',
            reasonCodes: ['USE_CASE_SESSION'],
          },
          {
            id: 'network.response_metadata',
            implemented: true,
            availability: 'unknown',
            constraints: ['无通用请求体/响应体', '缺记录不能证明请求未发生'],
          },
          {
            id: 'runtime.evidence',
            implemented: true,
            availability: 'unknown',
            requiredCapabilities: ['runtimeEvidenceV1'],
            constraints: ['节点必须支持 runtimeEvidenceV1'],
          },
          {
            id: 'identity.external',
            implemented: kind === 'verification',
            availability:
              kind === 'verification' && this.config.devPass
                ? 'unknown'
                : 'unavailable',
            reasonCodes:
              kind === 'browser'
                ? ['USE_CASE_SESSION']
                : this.config.devPass
                  ? ['ACCOUNT_NOT_RESERVED']
                  : ['DEVPASS_NOT_CONFIGURED'],
            constraints: [
              '仅接受 Case 声明的受控账号来源，不接受原始 Cookie 或令牌',
            ],
          },
        ].map((capability) => ({
          reasonCodes: ['RUNTIME_NOT_PROBED'],
          constraints: [],
          requiredCapabilities: [],
          source: 'implementation_and_config',
          checkedAt: new Date().toISOString(),
          ...capability,
        })),
        limits: {
          maxCases: 32,
          maxSteps: 32,
          maxRequestBytes: 2097152,
          supportedEvidenceKinds: [
            'DOM',
            'SCREENSHOT',
            'NETWORK',
            'TRACE',
            'RUNTIME',
          ],
          configuredEvidenceKinds: this.config.caseProfile?.evidenceKinds ?? [],
          sessionModes:
            kind === 'verification'
              ? ['auto', 'guest', 'manual', 'external']
              : [],
          grouping: '每个 setup 建立独立 tab 分组，组间可能并发',
          stepTimeoutMs: 300000,
          cleanupTimeoutMs: 180000,
        },
        unchecked: [
          '目标网络可达性',
          '实际账号与数据条件',
          'worker、模型及节点实时可用性',
        ],
      },
    };
  }

  /** 仅检查已存在 Case 的可见归属，不将旧管理员任务自动收归新调用方。 */
  private async checkCaseAccess(
    principal: string,
    caseId: string,
    query: PublicQuery = this.db,
  ) {
    const row = (
      await query.query(
        'SELECT run_id FROM pr_case_runs WHERE case_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC,run_id DESC LIMIT 1',
        [caseId],
      )
    ).rows[0];
    if (row) {
      try {
        await requireOwned(query, principal, { kind: 'run', id: row.run_id });
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        throw new ApiError(
          409,
          'RESOURCE_CONFLICT',
          'Case 身份不可用于此次提交',
        );
      }
    }
  }

  private async validate(
    principal: string,
    input: Extract<
      McpTaskCall,
      { name: 'verification_validate_cases' }
    >['arguments'],
  ) {
    const errors: Array<Record<string, unknown>> = [];
    const warnings: Array<Record<string, unknown>> = [];
    const executionPreview: Array<Record<string, unknown>> = [];
    if (
      new Set(input.cases.map((item) => item.caseId)).size !==
      input.cases.length
    )
      errors.push({
        path: '/cases',
        code: 'INVALID_CASE',
        message: 'Case 身份不能重复',
      });
    for (const [index, item] of input.cases.entries()) {
      try {
        await this.checkCaseAccess(principal, item.caseId);
        const task = (await this.cases.prepare([item]))[0]!;
        this.coordinator.externalAccounts.prepare(task);
        this.coordinator.externalAccounts.validate(task);
        executionPreview.push({
          caseId: item.caseId,
          groups: task.profilePlan?.groups ?? [],
          maxConcurrency:
            input.executor?.kind === 'external'
              ? 1
              : task.executionPlan?.evidenceKinds.some((kind) =>
                    ['NETWORK', 'TRACE', 'RUNTIME'].includes(kind),
                  )
                ? 1
                : (task.profilePlan?.maxConcurrency ?? 1),
          identity: {
            mode: task.sessionPlan?.mode,
            automatic: task.sessionPlan?.automatic ?? null,
          },
          stepBudget: task.stepBudget,
          sessionBudgetMs: sessionBudgetMs(task),
          evidenceKinds: task.executionPlan?.evidenceKinds ?? [],
          requiredCapabilities: task.executionPlan?.requiredCapabilities ?? [],
          availability: 'unknown',
        });
        if ((task.profilePlan?.groups.length ?? 0) > 1)
          warnings.push({
            path: `/cases/${index}/steps`,
            code: 'MULTIPLE_GROUPS',
            message: 'setup 分为独立 tab；exec_order 不是跨组依赖保证',
          });
        if (item.cleanup.length)
          warnings.push({
            path: `/cases/${index}/cleanup`,
            code: 'CLEANUP_CONDITIONAL',
            message: '取消、环境未就绪或撤权可能跳过业务清理，不能作为事务回滚',
          });
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        errors.push({
          path: `/cases/${index}`,
          code: error.code,
          message: error.message,
        });
      }
    }
    return {
      kind: 'validation',
      data: {
        valid: errors.length === 0,
        errors,
        warnings,
        definitionDigest: digest(canonical(input)),
        executionPreview,
        unchecked: ['实际环境与节点能力未预留', '身份准备与业务数据未验收'],
      },
    };
  }

  private submitBrowser(
    principal: string,
    input: Extract<McpTaskCall, { name: 'browser_task_submit' }>['arguments'],
  ) {
    return publicCall(
      this.db,
      principal,
      'browser-submit',
      input.taskKey,
      input,
      async (client) => {
        const runId = `browser-public-${digest(canonical([principal, input.taskKey]))}`;
        await lockPublic(client, runId);
        await checkBinding(client, principal, { kind: 'run', id: runId });
        await this.coordinator.submitBrowserInTransaction(
          { taskId: runId, url: input.url, objective: input.objective },
          client,
        );
        await bindOwned(client, principal, { kind: 'run', id: runId });
        return {
          result: {
            kind: 'submission',
            data: {
              acceptedAt: new Date().toISOString(),
              runs: [
                { runId, origin: 'created', executor: { kind: 'builtin' } },
              ],
            },
          },
          resources: [{ kind: 'run', id: runId }],
        };
      },
    );
  }

  private submitCases(
    principal: string,
    input: Extract<
      McpTaskCall,
      { name: 'verification_submit_cases' }
    >['arguments'],
  ) {
    const normalized = {
      ...input,
      title: input.title ?? input.requestId,
      executor: { kind: input.executor?.kind ?? 'builtin' },
      cases: [...input.cases].sort((a, b) => a.caseId.localeCompare(b.caseId)),
    };
    return publicCall(
      this.db,
      principal,
      'verification-submit',
      input.requestId,
      normalized,
      async (client) => {
        await lockPublic(client, `request:${input.requestId}`);
        await checkBinding(client, principal, {
          kind: 'request',
          id: input.requestId,
        });
        for (const item of input.cases)
          await this.checkCaseAccess(principal, item.caseId, client);
        const definitions = await this.cases.prepare(
          input.cases,
          transactionDefinitions(client),
        );
        await this.lockRuns(client, principal, definitions);
        const created = new Set<string>();
        for (const task of definitions)
          if (
            !(
              await client.query('SELECT 1 FROM pr_tasks WHERE id=$1', [
                task.taskId,
              ])
            ).rowCount
          )
            created.add(task.taskId);
        const executor = input.executor?.kind ?? 'builtin';
        for (const task of definitions) {
          const old = (
            await client.query(
              'SELECT executor_kind FROM pr_tasks WHERE id=$1',
              [task.taskId],
            )
          ).rows[0];
          if (old && old.executor_kind !== executor)
            throw new ApiError(
              409,
              'RUN_EXECUTOR_CONFLICT',
              '运行已绑定另一种执行者',
            );
          if (executor === 'external' && task.profilePlan)
            task.profilePlan.maxConcurrency = 1;
        }
        await this.coordinator.submitCaseBatch(
          definitions,
          requestIdentity(input),
          client,
        );
        if (executor === 'external')
          for (const task of definitions)
            await client.query(
              "UPDATE pr_tasks SET executor_kind='external',runtime_version=1,binding_deadline_at=coalesce(binding_deadline_at,least(deadline_at,clock_timestamp()+interval '10 minutes')) WHERE id=$1",
              [task.taskId],
            );
        await bindOwned(client, principal, {
          kind: 'request',
          id: input.requestId,
        });
        for (const task of definitions)
          await bindOwned(client, principal, { kind: 'run', id: task.taskId });
        const snapshot = await this.requests.snapshot(client, input.requestId);
        const runs = snapshot.cases.map((item) => ({
          caseId: item.caseId,
          runId: item.arms[0]!.taskId,
          origin: created.has(item.arms[0]!.taskId) ? 'created' : 'reused',
          executor: { kind: executor },
        }));
        return {
          result: {
            kind: 'submission',
            data: {
              requestId: input.requestId,
              acceptedAt: new Date().toISOString(),
              runs,
            },
          },
          resources: [
            { kind: 'request', id: input.requestId },
            ...runs.map((run) => ({ kind: 'run' as const, id: run.runId })),
          ],
        };
      },
    );
  }

  /** 与原入队锁同序；旧 API 并发创建也不能在归属检查后插入同一任务。 */
  private async lockRuns(
    client: PoolClient,
    principal: string,
    definitions: VerificationTask[],
  ) {
    for (const task of [...definitions].sort((a, b) =>
      a.taskId.localeCompare(b.taskId),
    )) {
      await lockPublic(client, task.taskId);
      await checkBinding(client, principal, { kind: 'run', id: task.taskId });
    }
  }

  private cancel(
    principal: string,
    name: string,
    input: Extract<McpTaskCall, { name: 'browser_task_cancel' }>['arguments'],
    kind: PublicChannel,
  ) {
    return publicCall(
      this.db,
      principal,
      'operation',
      input.operationId,
      { name, ...input },
      async (client) => {
        const row = await this.views.task(client, principal, input.runId);
        if ((row.definition.taskKind ?? 'verification') !== kind)
          throw new ApiError(
            404,
            'RESOURCE_NOT_FOUND',
            '此接入面不提供该任务类型',
          );
        await this.coordinator.cancelInTransaction(input.runId, client);
        const affected = (
          await client.query(
            `SELECT DISTINCT r.request_id FROM pr_request_runs r JOIN pr_public_owners o ON o.kind='request' AND o.resource_id=r.request_id AND o.principal_id=$2 JOIN pr_verification_requests v USING(request_id) WHERE r.task_id=$1 AND v.deleted_at IS NULL ORDER BY r.request_id LIMIT 101`,
            [input.runId, principal],
          )
        ).rows.map((r) => r.request_id);
        return {
          result: {
            kind: 'operation',
            data: {
              operationId: input.operationId,
              status: 'SUCCEEDED',
              effect: 'APPLIED',
              runId: input.runId,
              affectedRequests: affected.slice(0, 100),
              affectedRequestsTruncated: affected.length > 100,
              acceptedAt: new Date().toISOString(),
            },
          },
          resources: [{ kind: 'run', id: input.runId }],
        };
      },
    );
  }

  private rerun(
    principal: string,
    input: Extract<
      McpTaskCall,
      { name: 'verification_rerun_cases' }
    >['arguments'],
  ) {
    const normalized = {
      ...input,
      executor: { kind: 'builtin' },
      budgetMode: input.budgetMode ?? 'current',
      items: [...input.items].sort((a, b) => a.caseId.localeCompare(b.caseId)),
    };
    return publicCall(
      this.db,
      principal,
      'operation',
      input.operationId,
      { name: 'verification_rerun_cases', ...normalized },
      async (client) => {
        await lockPublic(client, `request:${input.requestId}`);
        await requireOwned(client, principal, {
          kind: 'request',
          id: input.requestId,
        });
        const source = await this.requests.snapshot(client, input.requestId);
        if (requestRevision(source) !== input.expectedRequestRevision)
          throw new ApiError(
            409,
            'REQUEST_REVISION_CONFLICT',
            '请求成员已变化，请刷新后重跑',
          );
        if (
          new Set(input.items.map((i) => i.caseId)).size !==
            input.items.length ||
          new Set(input.items.map((i) => i.runKey)).size !== input.items.length
        )
          throw new ApiError(422, 'INVALID_RERUN', 'Case 和运行键不能重复');
        const definitions: VerificationTask[] = [];
        for (const item of input.items) {
          const member = source.cases.find((c) => c.caseId === item.caseId);
          if (member?.arms[0]?.taskId !== item.sourceRunId)
            throw new ApiError(
              409,
              'REQUEST_REVISION_CONFLICT',
              '来源运行不是当前请求成员',
            );
          await requireOwned(client, principal, {
            kind: 'run',
            id: item.sourceRunId,
          });
          const executor = (
            await client.query(
              'SELECT executor_kind FROM pr_tasks WHERE id=$1',
              [item.sourceRunId],
            )
          ).rows[0];
          if (executor?.executor_kind === 'external')
            throw new ApiError(
              409,
              'RUN_EXECUTOR_CONFLICT',
              '外部执行请使用新 Case 身份提交并重新绑定',
            );
          const key = `public-${digest(canonical([principal, item.runKey]))}`;
          definitions.push(
            await this.cases.prepareRerun(
              item.caseId,
              key,
              input.budgetMode ?? 'current',
              input.timeBudget,
              item.sourceRunId,
              undefined,
              transactionDefinitions(client),
            ),
          );
        }
        await this.lockRuns(client, principal, definitions);
        await this.coordinator.submitCaseBatch(
          definitions,
          {
            requestId: input.requestId,
            title: source.title,
            hash: digest(canonical(normalized)),
            replaceRuns: true,
            sourceRequestId: input.requestId,
            rerunParameters: normalized,
          },
          client,
        );
        for (const task of definitions)
          await bindOwned(client, principal, { kind: 'run', id: task.taskId });
        const runs = definitions.map((task) => ({
          caseId: task.caseV2Definition!.caseId,
          runId: task.taskId,
          origin: 'created',
          executor: { kind: 'builtin' },
        }));
        return {
          result: {
            kind: 'operation',
            data: {
              operationId: input.operationId,
              status: 'SUCCEEDED',
              effect: 'APPLIED',
              requestId: input.requestId,
              runs,
              acceptedAt: new Date().toISOString(),
            },
          },
          resources: [
            { kind: 'request', id: input.requestId },
            ...runs.map((r) => ({ kind: 'run' as const, id: r.runId })),
          ],
        };
      },
    );
  }
}
