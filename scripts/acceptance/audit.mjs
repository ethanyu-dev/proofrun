import { readFile, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  validateTaskDetail,
  validateVerificationReport,
} from '../../contracts/dist/index.js';

/** 证据名来自报告，只接受单个文件名；不跟随符号链接读取目录外数据。 */
const ARTIFACT_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** 与节点 TRACE 上限对齐，避免离线审计无界加载文件。 */
const MAX_BYTES = 64 * 1024 * 1024;
/** 运行中快照不构成已完成验收材料。 */
const ACTIVE_STATES = new Set(['QUEUED', 'RUNNING']);

/** 摘要只绑定保存的材料，不证明材料来自某个部署版本或业务事实为真。 */
function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 拒绝链接及非普通文件，错误只暴露稳定代码，不输出页面或凭据内容。 */
async function readLocal(directory, name) {
  const path = join(directory, name);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > MAX_BYTES)
    throw Object.assign(new Error('文件类型或大小不符合要求'), {
      code: 'INVALID_FILE',
    });
  return readFile(path);
}

/** 核对一份既有导出；失败和缺失也返回记录，不修改输入、不访问任何网络。 */
export async function auditDirectory(input) {
  const directory = resolve(input);
  const issues = [];
  const sourceSha256 = {};
  const issue = (code, item = null) => issues.push({ code, item });
  const readJson = async (name, validate) => {
    try {
      const bytes = await readLocal(directory, name);
      sourceSha256[name] = digest(bytes);
      const value = JSON.parse(bytes);
      if (!validate(value)) {
        issue('INVALID_SCHEMA', name);
        return null;
      }
      return value;
    } catch (error) {
      issue(error.code === 'ENOENT' ? 'MISSING_FILE' : 'UNREADABLE_FILE', name);
      return null;
    }
  };
  const detail = await readJson('task.json', validateTaskDetail);
  const report = await readJson('report.json', validateVerificationReport);
  if (detail) {
    if (detail.id !== detail.definition.taskId)
      issue('TASK_ID_MISMATCH', 'task.json');
    if (ACTIVE_STATES.has(detail.state)) issue('TASK_NOT_TERMINAL');
    if (!isDeepStrictEqual(detail.report, report)) issue('REPORT_MISMATCH');
    if (report && report.taskId !== detail.id) issue('REPORT_TASK_MISMATCH');
  }

  const verifiedArtifacts = new Map();
  const artifacts = new Map();
  for (const artifact of report?.artifacts ?? []) {
    if (!ARTIFACT_ID.test(artifact.id)) {
      issue('INVALID_ARTIFACT_ID', artifact.id);
      continue;
    }
    if (artifacts.has(artifact.id)) {
      issue('DUPLICATE_ARTIFACT', artifact.id);
      continue;
    }
    artifacts.set(artifact.id, artifact);
    const extension = artifact.kind === 'SCREENSHOT' ? 'png' : 'json';
    try {
      const bytes = await readLocal(directory, `${artifact.id}.${extension}`);
      if (digest(bytes) !== artifact.sha256) {
        issue('ARTIFACT_HASH_MISMATCH', artifact.id);
        continue;
      }
      verifiedArtifacts.set(artifact.id, artifact);
    } catch (error) {
      issue(
        error.code === 'ENOENT' ? 'MISSING_ARTIFACT' : 'UNREADABLE_ARTIFACT',
        artifact.id,
      );
    }
  }

  const criteria = [];
  const expected = new Map(
    (detail?.definition.acceptanceCriteria ?? []).map((item) => [
      item.id,
      item,
    ]),
  );
  const seen = new Set();
  for (const criterion of report?.criteria ?? []) {
    if (seen.has(criterion.criterionId))
      issue('DUPLICATE_CRITERION', criterion.criterionId);
    seen.add(criterion.criterionId);
    const definition = expected.get(criterion.criterionId);
    if (detail && !definition)
      issue('UNKNOWN_CRITERION', criterion.criterionId);
    const refs = criterion.evidenceRefs;
    for (const ref of refs) {
      if (!verifiedArtifacts.has(ref)) issue('UNVERIFIED_EVIDENCE_REF', ref);
    }
    const kinds = new Set(refs.map((id) => verifiedArtifacts.get(id)?.kind));
    const decisive = ['PASSED', 'FAILED'].includes(criterion.verdict);
    const missingKinds = decisive
      ? (definition?.evidenceKinds ?? []).filter((kind) => !kinds.has(kind))
      : [];
    if (missingKinds.length)
      issue('MISSING_EVIDENCE_KIND', criterion.criterionId);
    criteria.push({
      criterionId: criterion.criterionId,
      reportedVerdict: criterion.verdict,
      evidenceVerified:
        refs.length > 0 && refs.every((id) => verifiedArtifacts.has(id)),
      missingKinds,
    });
  }
  for (const id of expected.keys()) {
    if (!seen.has(id)) issue('MISSING_CRITERION', id);
  }
  const closureVerified = detail?.executions.length
    ? detail.executions.every((execution) => execution.closure_verified)
    : null;
  if (closureVerified === false) issue('SESSION_NOT_CLOSED');
  if (report?.executionDisposition === 'EXECUTED' && closureVerified === null)
    issue('EXECUTION_RECORD_MISSING');
  if (
    report?.verdict === 'PASSED' &&
    (!report.criteria.length ||
      report.criteria.some((item) => item.verdict !== 'PASSED'))
  )
    issue('INCONSISTENT_PASSED_VERDICT');
  const metrics = report?.executionDetails;
  return {
    directory,
    taskId: detail?.id ?? report?.taskId ?? null,
    sourceSha256,
    state: detail?.state ?? null,
    createdAt: detail?.created_at ?? null,
    budget: detail?.definition.budget ?? null,
    executionMode: detail?.definition.executionMode ?? null,
    reportedVerdict: report?.verdict ?? null,
    executionDisposition: report?.executionDisposition ?? null,
    reasonCode: metrics?.reasonCode ?? null,
    closureVerified,
    integrity: issues.length ? 'INVALID_OR_INCOMPLETE' : 'VERIFIED',
    issues,
    artifacts: {
      declared: report?.artifacts.length ?? 0,
      verified: verifiedArtifacts.size,
    },
    criteria,
    metrics: {
      model: metrics?.model ?? null,
      elapsedMs: metrics?.elapsedMs ?? null,
      modelCalls: metrics?.modelCalls ?? null,
      actions: metrics?.actions ?? null,
      reportedPromptTokens: metrics?.promptTokens ?? null,
      reportedCompletionTokens: metrics?.completionTokens ?? null,
      usageComplete: null,
      cost: null,
    },
    // 导出格式未绑定部署摘要，也没有独立业务真值；不能从模型报告补造这些结论。
    deploymentVerified: false,
    businessReview: 'NOT_REVIEWED',
  };
}
