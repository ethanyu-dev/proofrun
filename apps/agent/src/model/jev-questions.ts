import type { Candidate } from './candidates.js';
import {
  JEV_SELECTION_RULES,
  JEV_NO_TARGET,
  jevCandidateReference,
  jevTargetQuestion,
} from '../prompts/jev.js';

/** 每组保留 NONE，确保单 Choice 不超过供应商 255 项限制。 */
const GROUP_SIZE = 254;
/** 扩展模式仍有本地总量边界，后续按文本及 token 预算进一步裁剪。 */
export const EXPANDED_ACTION_LIMIT = 2000;

/** 所有分组和动作编号只在当前观察、当前请求内有效。 */
export interface JevQuestions {
  /** 下一步与独立的各组目标问题。 */
  questions: Record<
    string,
    { type: string; criteria: Record<string, unknown>; instructions: unknown }
  >;
  /** 展开模式共享一次候选描述，避免各问题重复完整字段。 */
  fields: Record<string, unknown> | undefined;
  /** 根选择为分组时，只消费该组的回复；不比较不同组的局部概率。 */
  groups: Map<string, Record<string, unknown>>;
}

/** 把候选按动作分组；超过一组时分块，根问题从共享字段判断所需分块。 */
export function jevQuestions(
  actions: Map<string, Candidate>,
  controls: Record<string, unknown>,
  expanded: boolean,
): JevQuestions {
  const choices = { ...controls };
  const questions: JevQuestions['questions'] = {
    next: {
      type: 'choice',
      criteria: choices,
      instructions: { rules: JEV_SELECTION_RULES },
    },
  };
  const groups = new Map<string, Record<string, unknown>>();
  if (!expanded) {
    for (const [id, candidate] of actions)
      choices[id] = { operation: candidate.operation, field: candidate.field };
    return { questions, groups, fields: undefined };
  }
  const fields = Object.fromEntries(
    [...actions].map(([id, candidate]) => [
      id,
      { operation: candidate.operation, field: candidate.field },
    ]),
  );
  const byOperation = new Map<string, Array<[string, Candidate]>>();
  for (const entry of actions) {
    const entries = byOperation.get(entry[1].operation) ?? [];
    entries.push(entry);
    byOperation.set(entry[1].operation, entries);
  }
  for (const [operation, entries] of byOperation) {
    for (let offset = 0; offset < entries.length; offset += GROUP_SIZE) {
      const group = `G${groups.size + 1}`;
      const ids = entries.slice(offset, offset + GROUP_SIZE).map(([id]) => id);
      choices[group] = {
        operation,
        candidates: ids.map((id) => `candidates.${id}`),
      };
      const criteria = Object.fromEntries(
        ids.map((id) => [id, jevCandidateReference(id)]),
      );
      criteria.NONE = JEV_NO_TARGET;
      groups.set(group, criteria);
      questions[group] = {
        type: 'choice',
        criteria,
        instructions: jevTargetQuestion(operation),
      };
    }
  }
  return { questions, groups, fields };
}
