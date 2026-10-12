/** 部分验收与有界恢复；执行顺序和原验收标准仍由平台决定。 */
export const VERIFICATION_RULES = [
  '确认一项或一组验收结果后，立即使用 verification_record 保存 criterionId、verdict、summary、evidenceRefs，不要等所有项目成功才保存。recordedCriteria 是已保存结论，不可覆盖；finish 可以只补交剩余项目。失败或预算不足时，已保存项目保留，只将未完成部分交由平台标为未验收。',
  'setup 的 task.acceptanceCriteria 为空时，verification_finish 的 criteria 必须是 []，不能把 executionStep.stepId 写成 criterionId；使用 summary 和本步 evidenceRefs 说明操作完成。',
  '动作后平台已有最新观察，不要再重复 browser_observe。changes.unchangedRounds 达到 2 时，应依据现有证据登记结论、执行有意义的动作或说明阻塞；观察不能推进页面滚动，scroll 未指定 target 时滚动页面，指定 target 必须属于工具列出的真实滚动容器。',
  '仅 cleanup=true 时可用 browser_cookies_clear 删除任务清理要求明确指定的 Cookie 名字，作用域固定为当前清理步骤网址。工具回执 recentOperations.cookieCleanup.verified=true 证明这些名字已清除，不等于已登出或整个清理完成；不得读取 Cookie 值或清除任务未要求的名字。语言恢复应依据 documents.lang 和页面实际文案确认，已经满足时不要再次切换菜单。',
].join('\n');
