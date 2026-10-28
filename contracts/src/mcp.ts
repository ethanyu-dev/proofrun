import { read, expand } from './mcp-schema.js';
import { Ajv } from 'ajv';
import formats from 'ajv-formats';
import type { McpTaskCall } from './generated/mcp-task-call.js';
import type { McpTaskResult } from './generated/mcp-task-result.js';
export type { McpTaskCall, McpTaskResult };

/** 工具列表必须自包含，客户端不需要解析 proofrun.invalid 上的离线 Schema 引用。 */
type Schema = Record<string, any>;
/** 每个工具只声明自己的成功形状，避免把整套协议重复塞入发现上下文。 */
const RESULT_KIND: Record<McpTaskCall['name'], McpTaskResult['kind']> = {
  browser_get_capabilities: 'capabilities',
  browser_task_submit: 'submission',
  browser_task_get: 'run',
  browser_task_cancel: 'operation',
  browser_evidence_read: 'evidence',
  browser_operation_get: 'operation',
  verification_get_capabilities: 'capabilities',
  verification_validate_cases: 'validation',
  verification_submit_cases: 'submission',
  verification_get_request: 'request',
  verification_get_run: 'run',
  verification_cancel_run: 'operation',
  verification_rerun_cases: 'operation',
  verification_read_evidence: 'evidence',
  verification_operation_get: 'operation',
};
const callUrl = new URL(
  '../schemas/mcp-task-call.schema.json',
  import.meta.url,
);
const outputUrl = new URL(
  '../schemas/mcp-task-result.schema.json',
  import.meta.url,
);
const calls = expand(read(callUrl), callUrl) as Schema;
const resultSchema = expand(read(outputUrl), outputUrl) as Schema;
const errorUrl = new URL(
  '../schemas/public-error.schema.json',
  import.meta.url,
);
/** SDK 也校验 isError 的 structuredContent，所以工具输出显式包含错误分支。 */
export const taskMcpOutputSchema = {
  type: 'object',
  anyOf: [resultSchema, expand(read(errorUrl), errorUrl)],
};
/** 输入输出与运行时验证均由相同 JSON Schema 产生，不能只验证 TypeScript 类型。 */
export const taskMcpTools = (calls.oneOf as Schema[]).map((branch) => {
  const name = branch.properties.name.const as McpTaskCall['name'];
  return {
    name,
    description: branch.description as string,
    inputSchema: branch.properties.arguments as Schema,
    outputSchema: {
      type: 'object',
      anyOf: [
        resultSchema.oneOf.find(
          (result: Schema) =>
            result.properties.kind.const === RESULT_KIND[name],
        ),
        taskMcpOutputSchema.anyOf[1],
      ],
    },
  };
});
const ajv = new Ajv({ allErrors: true, strict: true });
formats.default(ajv);
export const validateMcpTaskCall = ajv.compile<McpTaskCall>(calls);
export const validateMcpTaskResult = ajv.compile<McpTaskResult>(resultSchema);
/** 预检可返回精确字段路径，避免联合类型其他分支的错误掩盖实际问题。 */
export const validateMcpArguments = new Map<string, ReturnType<Ajv['compile']>>(
  taskMcpTools.map((tool: { name: string; inputSchema: Schema }) => [
    tool.name,
    ajv.compile(tool.inputSchema),
  ]),
);
