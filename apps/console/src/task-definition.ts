import requestSchema from '../../../contracts/schemas/verification-request.schema.json';
import type { VerificationRequest } from '@proofrun/contracts';
import identityCheck from '../../../contracts/schemas/identity-check.schema.json';
import externalSelector from '../../../contracts/schemas/external-account-selector.schema.json';
import sessionRequest from '../../../contracts/schemas/session-request.schema.json';
import sessionPlan from '../../../contracts/schemas/session-plan.schema.json';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import type { VerificationTask, VerificationCaseV2 } from '@proofrun/contracts';
import schema from '../../../contracts/schemas/verification-task.schema.json';
import stepSchema from '../../../contracts/schemas/case-step.schema.json';
import caseV2Schema from '../../../contracts/schemas/verification-case-v2.schema.json';
import caseSchema from '../../../contracts/schemas/verification-case.schema.json';

/** 浏览器直接使用共享 schema，避免载入 contracts 的 Node 文件读取入口。 */
const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
// 任务的 caseDefinition 使用外部引用，浏览器校验器也须在编译任务前注册依赖。
ajv.addSchema(identityCheck);
ajv.addSchema(externalSelector);
ajv.addSchema(sessionRequest);
ajv.addSchema(sessionPlan);
ajv.addSchema(caseSchema);
ajv.addSchema(stepSchema);
ajv.addSchema(caseV2Schema);
const validate = ajv.compile<VerificationTask>(schema);

/** 控制台批量导入直接复用公开协议；跨任务冲突和平台配置仍由服务端校验。 */
const validateCaseBatch = ajv.compile<VerificationCaseV2[]>({
  type: 'array',
  minItems: 1,
  maxItems: 32,
  items: { $ref: caseV2Schema.$id },
});
/** 粘贴入口只补齐身份和空约束，不推测业务预期；调用方须保留返回值供失败重试。 */
export function parseCaseBatch(text: string): VerificationCaseV2[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('case 数组不是有效 JSON。');
  }
  if (Array.isArray(value))
    value = value.map((item: unknown) => {
      if (!isRecord(item)) return item;
      return {
        ...item,
        ...(item.caseId === undefined
          ? { caseId: `case-${crypto.randomUUID()}` }
          : {}),
        ...(Array.isArray(item.steps)
          ? {
              steps: item.steps.map((step: unknown) =>
                isRecord(step)
                  ? {
                      ...step,
                      ...(step.policy === undefined ? { policy: [] } : {}),
                      ...(step.type === 'setup' && step.expected === undefined
                        ? { expected: [] }
                        : {}),
                    }
                  : step,
              ),
            }
          : {}),
      };
    });
  if (!validateCaseBatch(value))
    throw new Error(
      `case 定义格式不正确：${validateCaseBatch.errors
        ?.slice(0, 3)
        .map((e) => `${e.instancePath || '/'} ${e.message}`)
        .join('；')}`,
    );
  if (new Set(value.map((item) => item.caseId)).size !== value.length)
    throw new Error('同一批次的 caseId 不能重复。');
  return value;
}

/** 只归一化 JSON 对象；空值和数组继续交给共享 schema 拒绝。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 表单与 JSON 共用一个任务对象；高级可选字段切换时完整保留。 */
export function parseTaskDefinition(text: string): VerificationTask {
  let task: unknown;
  try {
    task = JSON.parse(text);
  } catch {
    throw new Error('任务定义不是有效 JSON，请检查后重试。');
  }
  if (!validate(task))
    throw new Error(
      `任务定义格式不正确：${validate.errors
        ?.map((e) => `${e.instancePath || '/'} ${e.message}`)
        .slice(0, 3)
        .join('；')}`,
    );
  if (
    new Set(task.acceptanceCriteria.map((c) => c.id)).size !==
    task.acceptanceCriteria.length
  )
    throw new Error('验收项 ID 不能重复。');
  if (task.budget.maxActions > 10000 || task.budget.timeoutMs > 86400000)
    throw new Error('最大动作不能超过 10000 次，总时间不能超过 24 小时。');
  return task;
}

/** 默认预算沿用本地验证习惯；目标和验收结果必须由提交者填写。 */
export function newTaskDefinition(): VerificationTask {
  return {
    protocolVersion: '0.1',
    taskId: `task-${crypto.randomUUID()}`,
    objective: '',
    executionMode: 'llm',
    target: { url: '' },
    environment: {
      id: 'default',
      nodePool: 'internal',
      allowIntervention: false,
    },
    acceptanceCriteria: [
      {
        id: 'criterion-1',
        description: '',
        expectedResult: '',
        evidenceKinds: ['DOM'],
      },
    ],
    budget: { maxActions: 100, timeoutMs: 1200000 },
  };
}

/** 数组粘贴自动封装为请求；返回值必须在派发前写回草稿，网络失败重试沿用全部身份。 */
export function parseVerificationRequest(text: string): VerificationRequest {
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    throw new Error('请求不是有效 JSON。');
  }
  const value = Array.isArray(input)
    ? {
        requestId: `request-${crypto.randomUUID()}`,
        cases: parseCaseBatch(text),
      }
    : isRecord(input)
      ? { ...input, cases: parseCaseBatch(JSON.stringify(input.cases)) }
      : input;
  const validateRequest =
    ajv.getSchema<VerificationRequest>(requestSchema.$id) ??
    ajv.compile<VerificationRequest>(requestSchema);
  if (!validateRequest(value))
    throw new Error(
      '请求需要有效 requestId、可选 title 和 case 数组，不能包含未知字段。',
    );
  return value as VerificationRequest;
}
