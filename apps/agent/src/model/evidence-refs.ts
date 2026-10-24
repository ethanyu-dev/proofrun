import { EVIDENCE_REFS_DESCRIPTION } from '../prompts/tools.js';

/** 只递归收紧命名为 evidenceRefs 的数组，不改变引文、业务标准和其他字符串字段。 */
export function constrainEvidenceRefs(schema: object, ids: string[]): void {
  for (const [key, value] of Object.entries(schema)) {
    if (!value || typeof value !== 'object') continue;
    if (key === 'evidenceRefs' && value.type === 'array') {
      value.description = EVIDENCE_REFS_DESCRIPTION;
      if (ids.length) value.items = { ...value.items, enum: ids };
      else value.maxItems = 0;
    } else constrainEvidenceRefs(value, ids);
  }
}
