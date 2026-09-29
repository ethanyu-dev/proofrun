import { readFile, writeFile } from 'node:fs/promises';
import { format } from 'prettier';

/** 对外文档仅包含上层调用入口；业务对象结构始终从共享 Schema 生成。 */
const SCHEMAS = {
  'verification-case': 'VerificationCase',
  'case-result': 'CaseResult',
  'case-step': 'CaseStep',
  'step-result': 'StepResult',
  'verification-case-v2': 'VerificationCaseV2',
  'case-result-v2': 'CaseResultV2',
};
const OUTPUT = new URL('../contracts/public-api.openapi.json', import.meta.url);
/** 在线文档优先展示新协议，并明确旧协议仍用于兼容调用。 */
const TAG_V2 = 'Case API v2';
const TAG_V1 = 'Case API v1（兼容）';

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
      '新接入使用 /v2/cases 批量提交结构化步骤，/v1/cases 保留兼容。环境、身份、预算及执行策略由平台管理。接口需要部署管理员 Bearer 凭据，请仅由可信服务端保管；提交和取消会产生实际操作。由共享 Schema 生成，请勿手改。',
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
        '原子接收结构化 case 数组；每个对象是独立任务，内部串行',
        { type: 'array', items: ref('CaseResultV2') },
        {
          status: '202',
          requestBody: body({
            type: 'array',
            minItems: 1,
            maxItems: 32,
            items: ref('VerificationCaseV2'),
          }),
        },
      ),
    },
    '/v2/cases/{id}': {
      parameters: [pathId],
      get: operation(
        'getCaseV2',
        '读取步骤、验收与关联清理结果',
        ref('CaseResultV2'),
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
