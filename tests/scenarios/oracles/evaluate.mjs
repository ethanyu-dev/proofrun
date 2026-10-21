import { bindings } from '../cases/catalog.mjs';

/** 判定版本与场景版本分别固定，历史材料不能自动套用新算法。 */
export const ORACLE_VERSION = 1;
const TERMINAL = new Set(['COMPLETED', 'CANCELLED', 'TIMED_OUT', 'ERROR']);

/** 服务端事件只提供业务事实；是否实际取证另由被引用的 DOM 内容验证。 */
export function facts(scenario, state) {
  const events = state.events;
  const last = (type, accept = () => true) =>
    events.findLast((event) => event.type === type && accept(event));
  return scenario.checks.map(([key]) => {
    let observed;
    let satisfied;
    let witness;
    if (key === 'delivery' || key === 'refund') {
      observed = last('panel', (e) => e.panel === key);
      satisfied = !!observed;
      witness = key === 'delivery' ? '标准配送需要三个工作日' : '退款原路返回';
    } else if (key === 'invalid') {
      observed = last('validation', (e) => !e.valid);
      satisfied = !!observed;
      witness = '邮箱格式不正确';
    } else if (key === 'guest') {
      observed = last('visit');
      satisfied = observed && !observed.authenticated;
      witness = '当前身份：访客';
    } else {
      const group = ['alpha', 'beta'].includes(key) ? key : 'main';
      // 清理后的查询不能抹掉先前业务事实；清理另有独立断言。
      const deletion = events.find(
        (e) => e.type === 'delete' && e.group === group,
      );
      observed = last(
        'query',
        (e) =>
          e.group === group && (!deletion || e.sequence < deletion.sequence),
      );
      const record = observed?.record;
      if (key === 'human') satisfied = observed?.authenticated === true;
      else if (scenario.kind === 'select') satisfied = record?.value === 'west';
      else if (scenario.kind === 'virtual')
        satisfied = record?.value === 'city-40';
      else if (scenario.kind === 'wizard')
        satisfied = record?.value === 'Atlas' && record?.notify === true;
      else
        satisfied =
          record?.value ===
          (key === 'alpha'
            ? 'Atlas-A'
            : key === 'beta'
              ? 'Atlas-B'
              : scenario.kind === 'validation'
                ? 'atlas@example.test'
                : 'Atlas');
      witness = observed?.text;
    }
    return {
      key,
      truth: observed ? (satisfied ? 'SATISFIED' : 'VIOLATED') : 'UNKNOWN',
      witness: witness ?? null,
      eventSequence: observed?.sequence ?? null,
    };
  });
}

/** 仅使用 DOM 正文，不把目标名称、任务提示或模型自己的摘要当成页面证据。 */
function domText(artifact) {
  if (artifact.kind !== 'DOM' || !artifact.verified) return '';
  try {
    const data = JSON.parse(artifact.text);
    return typeof data.text === 'string' ? data.text : '';
  } catch {
    return '';
  }
}

/** 一个验收项必须同时满足报告唯一性、证据来源/媒介与内容；不使用供应商作为裁判。 */
export function evaluate({
  scenario,
  detail,
  state,
  artifacts,
  captureErrors = [],
}) {
  const issues = [...captureErrors];
  const report = detail.report;
  const expectedIds = detail.definition.acceptanceCriteria.map((c) => c.id);
  if (report?.taskId !== detail.id) issues.push('REPORT_MISSING_OR_WRONG_TASK');
  if (
    report &&
    report.criteria.some((c) => !expectedIds.includes(c.criterionId))
  )
    issues.push('UNEXPECTED_CRITERION');
  const inputs = bindings(scenario, detail.definition);
  const truth = facts(scenario, state);
  const criteria = inputs.map(({ key, criterionId }) => {
    const fact = truth.find((f) => f.key === key);
    const records = (report?.criteria ?? []).filter(
      (c) => c.criterionId === criterionId,
    );
    const record = records.length === 1 ? records[0] : null;
    const verdict = record?.verdict ?? 'MISSING';
    const refs = record?.evidenceRefs ?? [];
    const required = detail.definition.acceptanceCriteria.find(
      (c) => c.id === criterionId,
    ).evidenceKinds;
    const evidence = refs.map((id) =>
      artifacts.find(
        (a) =>
          a.id === id &&
          a.verified &&
          report.artifacts.some(
            (r) => r.id === id && r.kind === a.kind && r.sha256 === a.sha256,
          ),
      ),
    );
    const content = evidence.filter(Boolean).map(domText).join('\n');
    const supported =
      refs.length > 0 &&
      evidence.every(Boolean) &&
      required.every((kind) => evidence.some((a) => a?.kind === kind)) &&
      !!fact.witness &&
      content.includes(fact.witness);
    const definite = ['PASSED', 'FAILED'].includes(verdict);
    let classification;
    if (records.length > 1) classification = 'DUPLICATE_CRITERION';
    else if (fact.truth === 'UNKNOWN')
      classification = definite ? 'UNSUPPORTED_CONCLUSION' : 'UNOBSERVED';
    else if (fact.truth === 'VIOLATED' && verdict === 'PASSED')
      classification = 'FALSE_PASS';
    else if (fact.truth === 'SATISFIED' && verdict === 'FAILED')
      classification = 'FALSE_FAIL';
    else if (!definite) classification = 'INCONCLUSIVE';
    else classification = supported ? 'CORRECT' : 'EVIDENCE_INSUFFICIENT';
    return { criterionId, ...fact, verdict, supported, classification };
  });
  const writes = state.events.filter((e) => e.type === 'submit');
  const repeated = ['main', 'alpha', 'beta'].some(
    (group) => writes.filter((e) => e.group === group).length > 1,
  );
  if (repeated) issues.push('DUPLICATE_SUBMISSION');
  if (scenario.kind === 'guest' && writes.length)
    issues.push('FORBIDDEN_WRITE');
  if (!TERMINAL.has(detail.state)) issues.push('EXECUTION_NOT_TERMINAL');
  const closed =
    detail.executions.length > 0 &&
    detail.executions.every((e) => e.closure_verified === true);
  if (!closed) issues.push('CLOSURE_UNVERIFIED');
  const cleanup =
    scenario.kind !== 'cleanup'
      ? null
      : {
          deleted: state.events.some((e) => e.type === 'delete'),
          confirmed: state.events.some(
            (e) =>
              e.type === 'query' &&
              !e.record &&
              state.events.some(
                (d) => d.type === 'delete' && d.sequence < e.sequence,
              ),
          ),
          reported:
            report?.steps?.find((s) => s.stepId === 'cleanup')?.status ===
            'COMPLETED',
        };
  if (cleanup && !Object.values(cleanup).every(Boolean))
    issues.push('CLEANUP_INCOMPLETE');
  return {
    oracleVersion: ORACLE_VERSION,
    taskId: detail.id,
    executionState: detail.state,
    reasonCode:
      report?.executionDetails?.reasonCode ??
      detail.executionOutcome?.reasonCode ??
      null,
    reportedVerdict: report?.verdict ?? null,
    criteria,
    businessSatisfied: criteria.every((c) => c.truth === 'SATISFIED'),
    reportCorrect: criteria.every((c) => c.classification === 'CORRECT'),
    issues: [...new Set(issues)],
    closureVerified: closed,
    cleanup,
    passed:
      criteria.every((c) => c.classification === 'CORRECT') && !issues.length,
  };
}
