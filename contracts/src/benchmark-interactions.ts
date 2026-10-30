import type { BenchmarkCheck, BenchmarkCommand } from './benchmark.js';
import type { VerificationReport } from './generated/verification-report.js';

/** 两种基础交互共用于本地与线上；只使用合成资料，不访问真实账户或业务。 */
export const BASIC_INTERACTIONS = [
  { id: 'browser-validation', name: '基础交互：表单校验与修正提交' },
  { id: 'browser-search', name: '基础交互：空结果与查询恢复' },
] as const;
/** 部分交互过程必须先取得观察证据，再继续操作；不能只声明最终成功。 */
const OBJECTIVES: Record<string, string> = {
  'browser-validation':
    '先只填写姓名 Alice，保持城市为空并点击保存资料，确认页面提示“请填写城市”且尚未保存。然后补填城市 Hangzhou，再保存资料，确认保存成功且保存次数为 1。交付先前校验提示、最终姓名、城市和保存次数，不重复成功提交。',
  'browser-search':
    '在查询框输入 NO-SUCH 并查询，确认页面提示“没有匹配结果”。随后将查询替换为 ProofRun 并再次查询，读取找到的条目编号和库存数量。交付两次查询结果，不刷新页面，不写入业务数据。',
};
/** 未知场景不产生默认任务，避免遗漏路由时误测表单。 */
export function basicInteractionObjective(id: string): string | undefined {
  return OBJECTIVES[id];
}
/** 页面脚本仅实现被测业务，真实模型仍通过正式浏览器工具操作。 */
export function basicInteractionPage(id: string): string | undefined {
  if (id === 'browser-validation')
    return `<h1>资料校验</h1><form novalidate><label>姓名<input name="name"></label><label>城市<input name="city"></label><button type="submit">保存资料</button></form><p role="status">尚未保存</p><script>document.querySelector('form').onsubmit=async event=>{event.preventDefault();const value=Object.fromEntries(new FormData(event.target));const status=document.querySelector('[role=status]');if(!value.name||!value.city){status.textContent=!value.name?'请填写姓名；尚未保存':'请填写城市；尚未保存';return;}const response=await fetch(location.pathname+'/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});const result=await response.json();status.textContent='已保存：'+result.name+' / '+result.city+'；保存次数 '+result.count;};</script>`;
  if (id === 'browser-search')
    return `<h1>库存查询</h1><form><label>查询<input name="query"></label><button type="submit">查询库存</button></form><p role="status">尚未查询</p><script>document.querySelector('form').onsubmit=event=>{event.preventDefault();document.querySelector('[role=status]').textContent=event.target.elements.query.value==='ProofRun'?'条目编号 BOOK-42；库存 7 件':'没有匹配结果';};</script>`;
  return undefined;
}
/** 校验有序真实观察、实际写入账本和交付；模型总结不能代替中间状态与副作用证明。 */
export function basicInteractionChecks(
  id: string,
  report: VerificationReport | null,
  commands: BenchmarkCommand[],
  facts: { visits: number; writes: Record<string, unknown>[] },
): BenchmarkCheck[] {
  const observations = commands
    .filter(
      (c) => c.operation.type === 'browser.observe' && c.status === 'SUCCEEDED',
    )
    .map((c) => c.result);
  const validation = id === 'browser-validation';
  const earlier = observations.findIndex((o) =>
    String(o?.text ?? '').includes(validation ? '请填写城市' : '没有匹配结果'),
  );
  const later = observations.findIndex(
    (o, i) =>
      i > earlier &&
      String(o?.text ?? '').includes(
        validation
          ? '已保存：Alice / Hangzhou；保存次数 1'
          : '条目编号 BOOK-42；库存 7 件',
      ),
  );
  const writes = validation
    ? facts.writes.length === 1 &&
      facts.writes[0]?.name === 'Alice' &&
      facts.writes[0]?.city === 'Hangzhou' &&
      Object.keys(facts.writes[0]).length === 2
    : facts.writes.length === 0;
  const output = report?.browserResult?.output ?? '';
  const words = validation
    ? ['请填写城市', 'Alice', 'Hangzhou', '1']
    : ['没有匹配结果', 'BOOK-42', '7'];
  return [
    {
      name: '基础交互有序观察与副作用',
      passed:
        !!OBJECTIVES[id] &&
        facts.visits > 0 &&
        earlier >= 0 &&
        later > earlier &&
        writes,
      detail: `中间观察 ${earlier} → 最终观察 ${later}；写入 ${facts.writes.length} 次`,
    },
    {
      name: '基础交互实际交付',
      passed:
        report?.executionDisposition === 'EXECUTED' &&
        report.verdict === null &&
        report.browserResult?.outcome === 'COMPLETED' &&
        report.browserResult.evidenceRefs.length > 0 &&
        words.every((word) => output.includes(word)),
      detail:
        '必须交付中间结果、最终业务值及本次证据，不能用空验收数组冒充完成',
    },
  ];
}
