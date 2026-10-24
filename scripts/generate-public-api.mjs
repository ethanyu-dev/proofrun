import { readFile, writeFile } from 'node:fs/promises';
import { format } from 'prettier';

/** 对外文档仅包含上层调用入口；业务对象结构始终从共享 Schema 生成。 */
const SCHEMAS = {
  'external-account-selector': 'ExternalAccountSelector',
  'execution-outcome': 'ExecutionOutcome',
  'identity-check': 'IdentityCheck',
  'session-request': 'SessionRequest',
  'queue-reason': 'QueueReason',
  'verification-case': 'VerificationCase',
  'case-result': 'CaseResult',
  'case-step': 'CaseStep',
  'step-result': 'StepResult',
  'verification-case-v2': 'VerificationCaseV2',
  'case-result-v2': 'CaseResultV2',
  'verification-request': 'VerificationRequest',
  'request-summary': 'RequestSummary',
  'token-usage': 'TokenUsage',
  'request-metrics': 'RequestMetrics',
  'request-result-v2': 'RequestResultV2',
  'request-list': 'RequestList',
  'request-rerun': 'RequestRerun',
};
const OUTPUT = new URL('../contracts/public-api.openapi.json', import.meta.url);
/** 在线文档优先展示新协议，并明确旧协议仍用于兼容调用。 */
const TAG_V2 = 'Case API v2';
const TAG_V1 = 'Case API v1（兼容）';
/** 重跑时间参数仍受平台 24 小时会话上限约束；服务端另校验完整计划合计。 */
const MAX_RERUN_TIME_MS = 86_400_000;

/** 当前源文件使用的关键字兼容 2020-12；移除旧方言和离线身份，改成文档内引用。 */
function embed(value) {
  if (Array.isArray(value)) return value.map(embed);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      if (key === '$schema' || key === '$id') return [];
      if (key === '$ref') {
        const name = SCHEMAS[item.replace('.schema.json', '')];
        if (!name) throw new Error(`未登记的公共 Schema 引用：${item}`);
        return [[key, `#/components/schemas/${name}`]];
      }
      return [[key, embed(item)]];
    }),
  );
}

/** 构造文档对象，不参与服务端运行时校验。 */
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const object = (properties, required = Object.keys(properties)) => ({
  type: 'object',
  additionalProperties: false,
  required,
  properties,
});
const json = (schema) => ({ 'application/json': { schema } });
const response = (schema, description = '成功') => ({
  description,
  content: json(schema),
});
const body = (schema) => ({ required: true, content: json(schema) });
const pathId = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string' },
};
const error = { $ref: '#/components/responses/Error' };

/** 公共操作统一管理员认证；错误码的具体语义见接入文档，不用 message 驱动重试。 */
function operation(operationId, summary, schema, options = {}) {
  const { status = '200', ...rest } = options;
  return {
    operationId,
    tags: [operationId.endsWith('V2') ? TAG_V2 : TAG_V1],
    summary,
    responses: { [status]: response(schema), default: error },
    ...rest,
  };
}

const schemas = {};
for (const [file, name] of Object.entries(SCHEMAS)) {
  schemas[name] = embed(
    JSON.parse(
      await readFile(
        new URL(`../contracts/schemas/${file}.schema.json`, import.meta.url),
        'utf8',
      ),
    ),
  );
}
schemas.Error = object({
  code: { type: 'string' },
  message: { type: 'string' },
});
const example = JSON.parse(
  await readFile(
    new URL('../contracts/examples/public-api/case.json', import.meta.url),
    'utf8',
  ),
);
const submitBody = body(ref('VerificationCase'));
submitBody.content['application/json'].example = example;

const document = {
  openapi: '3.1.0',
  info: {
    title: 'ProofRun Case API',
    version: '0.1.0',
    description:
      '新接入使用 /v2/cases 批量提交结构化步骤，/v1/cases 保留兼容。环境、身份、预算及执行策略由平台管理。新建 v2 只支持 LLM 单组，每步独立 300 秒，动作与模型额度按步骤类型及验收项数冻结；历史 comparison.arms 继续只读，旧 JEV/parallel 不再接受。接口需要部署管理员 Bearer 凭据，请仅由可信服务端保管；提交和取消会产生实际操作。由共享 Schema 生成，请勿手改。',
  },
  servers: [
    { url: 'https://api-proofrun.ethankit.com', description: '生产 HTTP API' },
    { url: '/', description: '自部署时替换为实际控制面 origin。' },
  ],
  externalDocs: {
    description: 'HTTP 接入说明与 v2 协议',
    url: 'https://github.com/ethanyu-dev/proofrun/blob/main/docs/public-api.md',
  },
  security: [{ AdminBearer: [] }],
  tags: [
    {
      name: TAG_V2,
      description: '新接入使用：结构化步骤、批量提交与关联清理。',
    },
    {
      name: TAG_V1,
      description: '保留已有单 case 调用，新的集成优先选择 v2。',
    },
  ],
  paths: {
    '/v2/cases': {
      post: operation(
        'submitCasesV2',
        '原子接收请求封装或兼容 case 数组；请求封装保留归属与汇总',
        {
          oneOf: [
            ref('RequestResultV2'),
            { type: 'array', items: ref('CaseResultV2') },
          ],
        },
        {
          status: '202',
          requestBody: body({
            oneOf: [
              ref('VerificationRequest'),
              {
                type: 'array',
                minItems: 1,
                maxItems: 32,
                items: ref('VerificationCaseV2'),
              },
            ],
          }),
        },
      ),
    },
    '/v2/requests': {
      get: operation(
        'listRequestsV2',
        '按请求分页查询完整成员汇总',
        ref('RequestList'),
        {
          parameters: [
            {
              name: 'q',
              in: 'query',
              schema: { type: 'string', maxLength: 160 },
            },
            {
              name: 'executionStatus',
              in: 'query',
              schema: { enum: ['QUEUED', 'IN_PROGRESS', 'FINISHED'] },
            },
            {
              name: 'reportStatus',
              in: 'query',
              schema: { enum: ['PASSED', 'FAILED', 'INCONCLUSIVE'] },
            },
            {
              name: 'limit',
              in: 'query',
              schema: {
                type: 'integer',
                minimum: 1,
                maximum: 100,
                default: 25,
              },
            },
            { name: 'cursor', in: 'query', schema: { type: 'string' } },
          ],
        },
      ),
    },
    '/v2/requests/{id}': {
      parameters: [pathId],
      get: operation(
        'getRequestV2',
        '读取请求归属、执行进度与报告快照',
        ref('RequestResultV2'),
      ),
    },
    '/v2/requests/{id}/report': {
      parameters: [pathId],
      get: operation(
        'getRequestReportV2',
        '读取请求汇总报告，部分结果明确标记',
        ref('RequestResultV2'),
      ),
    },
    '/v2/requests/{id}/rerun': {
      parameters: [pathId],
      post: operation(
        'rerunRequestV2',
        '以新请求和运行身份原子重跑全部成员，保留 caseId',
        ref('RequestResultV2'),
        { status: '202', requestBody: body(ref('RequestRerun')) },
      ),
    },
    '/v2/cases/{id}': {
      parameters: [pathId],
      get: operation(
        'getCaseV2',
        '读取步骤、验收与关联清理结果',
        ref('CaseResultV2'),
        {
          parameters: [
            {
              name: 'runId',
              in: 'query',
              schema: { type: 'string' },
              description:
                '省略时读取最新未删除运行；历史运行使用返回的 runId。',
            },
          ],
        },
      ),
    },
    '/v2/cases/{id}/runs': {
      parameters: [pathId],
      get: operation(
        'listCaseRunsV2',
        '按时间倒序读取未删除运行，包含旧数据首轮记录',
        object({
          runs: {
            type: 'array',
            items: object({
              runId: { type: 'string' },
              taskId: { type: 'string' },
              state: { type: 'string' },
              createdAt: { type: 'string', format: 'date-time' },
              finishedAt: { type: ['string', 'null'], format: 'date-time' },
            }),
          },
        }),
      ),
    },
    '/v1/tasks/delete': {
      post: operation(
        'deleteTaskRuns',
        '原子软删除一至一百条已结束运行及其双跑和清理记录',
        object({
          deletedTaskIds: { type: 'array', items: { type: 'string' } },
          deletedRequestIds: { type: 'array', items: { type: 'string' } },
        }),
        {
          requestBody: body(
            object({
              ids: {
                type: 'array',
                minItems: 1,
                maxItems: 100,
                items: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,160}$' },
              },
            }),
          ),
        },
      ),
    },
    '/v2/requests/delete': {
      post: operation(
        'deleteRequestsV2',
        '软删除请求，仍被其他请求引用的执行保留',
        object({
          deletedTaskIds: { type: 'array', items: { type: 'string' } },
          deletedRequestIds: { type: 'array', items: { type: 'string' } },
        }),
        {
          requestBody: body(
            object({
              ids: {
                type: 'array',
                minItems: 1,
                maxItems: 100,
                items: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,80}$' },
              },
            }),
          ),
        },
      ),
    },
    '/v2/cases/{id}/rerun': {
      parameters: [pathId],
      post: operation(
        'rerunCaseV2',
        '保留 caseId 新增一次运行；默认采用当前预算策略，可选择原预算',
        ref('CaseResultV2'),
        {
          status: '202',
          requestBody: body(
            object(
              {
                runId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,80}$' },
                budgetMode: {
                  enum: ['current', 'original'],
                  default: 'current',
                },
                timeBudget: {
                  ...object(
                    {
                      stepTimeoutMs: {
                        type: 'integer',
                        minimum: 1,
                        maximum: MAX_RERUN_TIME_MS,
                        description:
                          '每个业务步骤的最低总时长，包含等待；毫秒。',
                      },
                      cleanupTimeoutMs: {
                        type: 'integer',
                        minimum: 1,
                        maximum: MAX_RERUN_TIME_MS,
                        description: '整段清理共享的最低总时长；毫秒。',
                      },
                    },
                    [],
                  ),
                  minProperties: 1,
                  description:
                    '只扩展新任务的时间额度；完整会话仍须在 24 小时内，相同 runId 保留首次冻结值。',
                },
              },
              ['runId'],
            ),
          ),
        },
      ),
    },
    '/v2/cases/{id}/cancel': {
      parameters: [pathId],
      post: operation(
        'cancelCaseV2',
        '取消主任务；已声明的副作用清理仍独立执行',
        ref('CaseResultV2'),
      ),
    },
    '/v2/cases/{id}/evidence/{artifactId}': {
      parameters: [
        pathId,
        {
          name: 'artifactId',
          in: 'path',
          required: true,
          schema: { type: 'string' },
        },
      ],
      get: {
        operationId: 'downloadCaseEvidenceV2',
        tags: [TAG_V2],
        summary: '读取主任务或关联清理结果的证据',
        responses: {
          200: {
            description: '截图为 PNG，其他证据为 JSON。',
            content: {
              'image/png': { schema: { type: 'string', format: 'binary' } },
              'application/json': {
                schema: { type: 'object', additionalProperties: true },
              },
            },
          },
          default: error,
        },
      },
    },
    '/v1/cases': {
      post: operation(
        'submitCase',
        '幂等提交一次 case 验证',
        ref('CaseResult'),
        { status: '202', requestBody: submitBody },
      ),
    },
    '/v1/cases/{id}': {
      parameters: [pathId],
      get: operation('getCase', '读取 case 状态和结果', ref('CaseResult')),
    },
    '/v1/cases/{id}/cancel': {
      parameters: [pathId],
      post: operation(
        'cancelCase',
        '取消本次验证；已完成的业务操作不回滚',
        ref('CaseResult'),
      ),
    },
    '/v1/cases/{id}/evidence/{artifactId}': {
      parameters: [
        pathId,
        {
          name: 'artifactId',
          in: 'path',
          required: true,
          schema: { type: 'string' },
        },
      ],
      get: {
        operationId: 'downloadCaseEvidence',
        tags: [TAG_V1],
        summary: '读取本 case 报告引用的证据',
        responses: {
          200: {
            description: '截图为 PNG，其他证据为 JSON。',
            content: {
              'image/png': { schema: { type: 'string', format: 'binary' } },
              'application/json': {
                schema: { type: 'object', additionalProperties: true },
              },
            },
          },
          default: error,
        },
      },
    },
  },
  components: {
    securitySchemes: {
      AdminBearer: {
        type: 'http',
        scheme: 'bearer',
        description: 'PROOFRUN_ADMIN_TOKEN；当前为全局管理员权限。',
      },
    },
    responses: {
      Error: response(
        ref('Error'),
        '应用错误；按 HTTP 状态和 code 处理，网关错误可能不是此结构。',
      ),
    },
    schemas,
  },
};
const output = await format(JSON.stringify(document), { parser: 'json' });
if (process.argv.includes('--check')) {
  if ((await readFile(OUTPUT, 'utf8').catch(() => null)) !== output) {
    console.error('公共 OpenAPI 已漂移，请执行 pnpm contracts:generate');
    process.exitCode = 1;
  }
} else {
  await writeFile(OUTPUT, output);
}
