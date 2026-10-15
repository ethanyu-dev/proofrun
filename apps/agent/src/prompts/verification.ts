/** 部分验收与有界恢复；执行顺序和原验收标准仍由平台决定。 */
export const VERIFICATION_RULES = [
  'evidenceRefs 只能逐字复制 evidence.id 或 artifactRefs.artifactId；observationId、commandId 和页面内的 UUID 不是附件，禁止改写 UUID。每个 criterionId 独立按自身要求判定；某一 FAQ 或异常分支缺证不能拖累不依赖它的静态文案标准，也不能把局部通过外推为整页通过。',
  '确认一项或一组验收结果后，立即使用 verification_record 保存 criterionId、verdict、summary、evidenceRefs，不要等所有项目成功才保存。recordedCriteria 中 PASSED/FAILED 是不可改写的已确认结论；INCONCLUSIVE/SKIPPED 是暂存结果，补齐本步骤新增有效证据后可升级为 PASSED/FAILED，不得仅凭旧证据换判定。finish 可以只补交剩余项目和可升级项目；同判定重送不会覆盖原说明，也不算新进展。仍可继续取证时优先记录 workflow.readings，不必提前给未覆盖整项定论。失败或预算不足时保留已有结果。',
  '逐条核对验收状态的触发前提与 executionStep.policy。要求未登录或禁止提交时，不得为触发绑定失败等结果越过约束；仅完成允许的前端校验，对无法触发的状态说明缺失前提，使用 INCONCLUSIVE 或 verification_block，不反复填写等待，也不把单一错误提示外推到全部异常状态。',
  'setup 的 task.acceptanceCriteria 为空时，verification_finish 的 criteria 必须是 []，不能把 executionStep.stepId 写成 criterionId；使用 summary 和本步 evidenceRefs 说明操作完成。',
  '动作后平台已有最新观察，不要再重复 browser_observe。changes.unchangedRounds 达到 2 时，应依据现有证据登记结论、执行有意义的动作或说明阻塞；观察不能推进页面滚动，scroll 未指定 target 时滚动页面，指定 target 必须属于工具列出的真实滚动容器。',
  '仅 cleanup=true 时可用 browser_cookies_clear 删除任务清理要求明确指定的 Cookie 名字，作用域固定为当前清理步骤网址。工具回执 recentOperations.cookieCleanup.verified=true 证明这些名字已清除，不等于已登出或整个清理完成；不得读取 Cookie 值或清除任务未要求的名字。语言恢复应依据 documents.lang 和页面实际文案确认，已经满足时不要再次切换菜单。',
].join('\n');
