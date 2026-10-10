import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import formatsPlugin from 'ajv-formats';
import type { VerificationTask } from './generated/verification-task.js';
import type { ControlRequest } from './generated/control-request.js';
import type { NodeEvent } from './generated/node-event.js';
import type { NodeCommand } from './generated/node-command.js';
import type { VerificationReport } from './generated/verification-report.js';

import type { ExecutionGrant } from './generated/execution-grant.js';
import type { AgentDecision } from './generated/agent-decision.js';

export type { VerificationTask, VerificationReport };
export type { NodeCommand } from './generated/node-command.js';
export const protocolVersion = '0.1' as const;
export { recoverableObservationFailure } from './observation-failure.js';

const ajv = new Ajv({ allErrors: true, strict: true });
formatsPlugin.default(ajv);

const readSchema = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(`../schemas/${name}.schema.json`, import.meta.url),
      'utf8',
    ),
  );

// 这里只做结构校验；租约归属、验收项覆盖和证据真实性由控制面领域层校验。
export type { QueueReason } from './generated/queue-reason.js';
ajv.addSchema(readSchema('queue-reason'), 'queue-reason.schema.json');
export type { VerificationCase } from './generated/verification-case.js';
export type { CaseResult } from './generated/case-result.js';
import type { VerificationCase } from './generated/verification-case.js';
import type { CaseResult } from './generated/case-result.js';
export const validateVerificationCase = ajv.compile<VerificationCase>(
  readSchema('verification-case'),
);
ajv.addSchema(
  { $ref: readSchema('verification-case').$id },
  'verification-case.schema.json',
);
export const validateCaseResult = ajv.compile<CaseResult>(
  readSchema('case-result'),
);
// 结构化协议先注册引用，所有执行组件共享同一份运行时约束。
export type { CaseStep } from './generated/case-step.js';
export type { StepResult } from './generated/step-result.js';
export type { VerificationCaseV2 } from './generated/verification-case-v2.js';
export type { CaseResultV2 } from './generated/case-result-v2.js';
import type { VerificationCaseV2 } from './generated/verification-case-v2.js';
import type { StepResult } from './generated/step-result.js';
import type { CaseResultV2 } from './generated/case-result-v2.js';
ajv.addSchema(readSchema('case-step'), 'case-step.schema.json');
ajv.addSchema(readSchema('step-result'), 'step-result.schema.json');
export const validateStepResults = ajv.compile<StepResult[]>({
  type: 'array',
  minItems: 1,
  maxItems: 64,
  items: { $ref: 'step-result.schema.json' },
});
ajv.addSchema(
  readSchema('verification-case-v2'),
  'verification-case-v2.schema.json',
);
export const validateVerificationCaseV2 = ajv.getSchema<VerificationCaseV2>(
  'verification-case-v2.schema.json',
)!;
export const validateCaseResultV2 = ajv.compile<CaseResultV2>(
  readSchema('case-result-v2'),
);
export const validateVerificationTask = ajv.compile<VerificationTask>(
  readSchema('verification-task'),
);
export const validateVerificationReport = ajv.compile<VerificationReport>(
  readSchema('verification-report'),
);

ajv.addSchema(readSchema('node-command'), 'node-command.schema.json');
ajv.addSchema(
  {
    $ref: 'https://proofrun.invalid/contracts/0.1/verification-report.schema.json',
  },
  'verification-report.schema.json',
);
export const validateNodeCommand = ajv.getSchema<NodeCommand>(
  'node-command.schema.json',
)!;

export type { NodeEvent } from './generated/node-event.js';
export const validateNodeEvent = ajv.compile<NodeEvent>(
  readSchema('node-event'),
);

export type { ControlRequest } from './generated/control-request.js';
export const validateControlRequest = ajv.compile<ControlRequest>(
  readSchema('control-request'),
);

export type { ExecutionGrant } from './generated/execution-grant.js';
export type { AgentDecision } from './generated/agent-decision.js';
ajv.addSchema(
  {
    $ref: 'https://proofrun.invalid/contracts/0.1/verification-task.schema.json',
  },
  'verification-task.schema.json',
);
export const validateExecutionGrant = ajv.compile<ExecutionGrant>(
  readSchema('execution-grant'),
);
/** 传给模型的工具约束和执行器校验使用同一份定义。 */
export const agentDecisionSchema = readSchema('agent-decision');
export const validateAgentDecision =
  ajv.compile<AgentDecision>(agentDecisionSchema);

export type { TaskList, TaskSummary } from './generated/task-list.js';
export type { TaskDetail } from './generated/task-detail.js';
export type { NodeList, NodeSummary } from './generated/node-list.js';
/** 控制台读取协议与服务端输出验证共用定义，避免按数据库行推断响应。 */
export const validateTaskList = ajv.compile(readSchema('task-list'));
export const validateTaskDetail = ajv.compile(readSchema('task-detail'));
export const validateNodeList = ajv.compile(readSchema('node-list'));

import type { ExecutionActivity } from './generated/execution-activity.js';
export type { ExecutionActivity };
export const validateExecutionActivity = ajv.compile<ExecutionActivity>(
  readSchema('execution-activity'),
);

import type { HitlClient } from './generated/hitl-client.js';
export type { HitlClient };
export type { HitlServer } from './generated/hitl-server.js';
/** 浏览器实时通道只接收封闭消息，不能透传 CDP 或引擎管理命令。 */
export const validateHitlClient = ajv.compile<HitlClient>(
  readSchema('hitl-client'),
);

import type { ModelCall } from './generated/model-call.js';
import type { ModelCallWrite } from './generated/model-call-write.js';
export type { ModelCall, ModelCallWrite };
/** 调用审计与节点动作分开校验，记录不能授权新的浏览器操作。 */
export const validateModelCall = ajv.compile<ModelCall>(
  readSchema('model-call'),
);
ajv.addSchema({ $ref: readSchema('model-call').$id }, 'model-call.schema.json');
export const validateModelCallWrite = ajv.compile<ModelCallWrite>(
  readSchema('model-call-write'),
);

import type { NodeRoutingWrite } from './generated/node-routing-write.js';
export type { NodeRoutingWrite };
/** 域名写入结构先校验，归一化、归属和并发版本由节点模块检查。 */
export const validateNodeRoutingWrite = ajv.compile<NodeRoutingWrite>(
  readSchema('node-routing-write'),
);

export {
  summarizeReport,
  type ReportFacts,
  type ReportScope,
} from './report-status.js';
