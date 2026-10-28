import {
  type ExecutionTool,
  executionMcpCatalog,
  validateExecutionMcpArguments,
  validateExternalExecutionRequest,
  validateMcpArguments,
} from '@proofrun/contracts';
import { ApiError } from '../../domain.js';
import type { ExternalExecution } from '../external-execution/service.js';
import type {
  PublicCredential,
  PublicChannel,
} from '../public-execution/auth.js';
import {
  PublicInputError,
  type PublicTaskService,
} from '../public-execution/service.js';

/** 相同目录元数据用于发现、授权和派发，不能只依赖客户端隐藏工具。 */
export const executionTool = (name: string): ExecutionTool | undefined =>
  executionMcpCatalog.find((tool) => tool.name === name);
/** MCP 是第三阶段服务的协议适配器，不发环回 HTTP、不重建执行状态或账本。 */
export class McpExecutionTools {
  constructor(
    private readonly external: ExternalExecution,
    private readonly tasks: PublicTaskService,
  ) {}
  /** 未识别的任务工具交回原服务；已识别工具的错误绝不降级为另一个入口。 */
  async execute(
    principal: PublicCredential,
    channel: PublicChannel,
    name: string,
    args: unknown,
  ): Promise<Record<string, unknown> | undefined> {
    const tool = executionTool(name);
    const operation =
      name === 'browser_operation_get' || name === 'verification_operation_get';
    if (!tool && !operation) return undefined;
    if (
      !name.startsWith(`${channel}_`) ||
      !principal.channels.includes(channel)
    )
      throw new ApiError(404, 'TOOL_NOT_FOUND', '工具不属于此接入面');
    this.external.permission(principal, tool?.scope ?? 'runs:read', channel);
    const validate = tool
      ? validateExecutionMcpArguments.get(name)!
      : validateMcpArguments.get(name)!;
    if (!validate(args))
      throw new PublicInputError(
        (validate.errors ?? []).slice(0, 100).map((error) => ({
          path: error.instancePath,
          message: error.message ?? '参数无效',
        })),
      );
    const input = args as Record<string, unknown>;
    if (operation)
      return (
        (await this.external.operation(principal, String(input.operationId))) ??
        undefined
      );
    if (tool!.taskKind) {
      const kind =
        tool!.request === 'bind'
          ? await this.tasks.channelForRun(
              principal.principalId,
              String(input.runId),
            )
          : await this.external.kind(principal, String(input.controllerId));
      if (kind !== tool!.taskKind)
        throw new ApiError(409, 'RUN_KIND_CONFLICT', '工具不适用于此运行类型');
    }
    if (tool!.request === 'view')
      return this.external.view(principal, String(input.controllerId));
    const { controllerId, runId, ...body } = input;
    const request = { ...body, type: tool!.request };
    // 再次经过 HTTP 使用的共同输入契约，防止未来工具投影漂移时扩大底层接口。
    if (!validateExternalExecutionRequest(request))
      throw new ApiError(400, 'INVALID_INPUT', '操作参数不符合底层执行契约');
    switch (request.type) {
      case 'open':
        return this.external.open(principal, request);
      case 'bind':
        return this.external.bind(principal, String(runId), request);
      case 'touch':
      case 'close':
        return this.external.control(principal, String(controllerId), request);
      case 'decide':
        return this.external.decide(principal, String(controllerId), request);
    }
  }
}
