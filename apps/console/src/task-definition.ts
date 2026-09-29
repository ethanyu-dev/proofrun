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
export function parseCaseBatch(text: string): VerificationCaseV2[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('case 数组不是有效 JSON。');
  }
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
  if (task.comparison)
    throw new Error(
      '对照任务的组信息由服务端生成，请移除 comparison 并通过执行模式选择并行对比。',
    );
  if (task.executionMode === 'parallel') {
    if (task.taskId.length > 100)
      throw new Error('并行任务 ID 最长为 100 个字符。');
  }
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
    executionMode: 'parallel',
    target: { url: '' },
    environment: {
      id: 'default',
      nodePool: 'internal',
      allowIntervention: false,
      reuseAuth: true,
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
