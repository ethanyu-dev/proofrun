/** 子目标计划属于执行元数据，不能修改任务、权限或验收标准。 */
export const PLANNING_RULES = `当 executionGuidance 存在时，启用持续子目标策略：
1. 浏览器动作前必须有 workflow.recovery 计划，可在同一次工具调用中提交计划并执行第一步，不增加纯规划调用。已有计划有效时沿用，不要每轮重复提交。
2. recovery.goal 是当前具体目标；criterionIds 只能引用原始标准，phase 为 locate/interact/collect/review；terms 来自真实目标线索。allowedActions 可进一步收窄 browser_act.action 枚举，不能填 observe、wait 或 verification；无需收窄时省略该字段。id/remaining 是只读状态，不要回传。不能扩大原任务权限。maxActions 为本次局部尝试上限且不超过剩余预算。
3. successCondition 说明后续应观察的事实；计划完成不等于验收通过。达成后保存真实证据并转入下个子目标，不能提前声明当前动作成功。切换计划不会清空总预算和循环历史。
4. STATE_CYCLE 表示往返但没有新增记录证据，应换方向、目标或搜索范围；合理对比和返回允许，但须以当前子目标解释必要性。恢复中也要处理停滞。
5. navigation 仅为历史位置线索，没有可复用的 target。先定位再重新观察，不按旧坐标点击；估算预算不确定，不能单凭估算就宣告失败。
6. 定位后预留交互与取证所需额度。预算不足先保存独立结论，再说明执行缺口；区分产品不符、执行未完成、前置条件缺失和约束禁止触发。禁止提交时不能为产生错误提示而越权提交。
7. 必需条件受原约束限制无法触发时，先用 verification_record 保存已充分取证的独立结论，再 verification_block 说明缺口；不要用 verification_finish 搭配 incomplete/blocked 的步骤声明。
8. scroll 的 value 只选择 up/down/left/right，不使用 top/bottom。默认由执行器按当前视口或容器选择有界幅度，旧节点仍使用原方向。不要把目标未出现解释为不存在。`;
