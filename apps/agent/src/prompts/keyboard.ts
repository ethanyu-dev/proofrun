/** 按键的请求意图、节点焦点确认和业务结果必须分别判断。 */
export const KEYBOARD_RULES =
  'press 不带 target 时只向当前焦点按键，不会聚焦历史输入框。仅 observation.viewport.targetedPress=true 时可指定当前 observation.targets 中的 target；节点会先聚焦并确认目标，再派发按键。旧节点请先 click 聚焦目标，重新观察后再按键。recentOperations/actionMemory 的 requestedTargetName 只表示请求意图；keyboard.focusVerified=true 仅证明按键前已确认焦点，不能证明 Tab 后发生失焦校验、出现错误提示或业务成功，必须读取动作后的页面证据。';
