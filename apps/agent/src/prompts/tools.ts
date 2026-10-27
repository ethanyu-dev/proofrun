/** 工具用途提示独立于协议结构；权限、目标和证据枚举由本轮事实收紧。 */
export const TOOL_DESCRIPTIONS: Record<string, string> = {
  'browser.observe':
    '只读观察当前页面；page.runtime 提供同会话 Service Worker、Cache Storage 和 Console 的范围与完整性，page.network 提供网络请求摘要，响应头与重定向关联通过 network_request_detail 按需读取。不要求人工打开 DevTools。unavailable、truncated 或 complete=false 不能证明无异常；无注册与读取失败须区分。动作后程序已经自动观察。',
  'browser.act':
    '执行一个受限动作。元素操作只引用 page.targets；scroll 的 value 只填 up、down、left、right，不传像素数或 top/bottom，滚动距离由执行器根据当前视口计算，历史回执里的方向加像素数不能作为工具参数。可用 progress 先保存动作前的事实，再执行动作。online 只派发一次 online 事件；pwa.cleanup 仅清理阶段清理当前 origin 的 SW 与缓存；network.probe 的 target 仅允许当前页面已观察的同源 /_next/image URL 参数变体，结果明确为不携带登录凭据的公开请求。不得以页面打开代替运行时验收。',
  'browser.wait':
    '有界等待明确的选择器和文本条件；未命中不证明业务失败，不得重放此前提交。',
  'browser.cookies.clear':
    '仅在清理阶段删除任务站点授权名称的 Cookie，程序校验清理回执；不返回 Cookie 值。',
  'verification.record':
    '持久化新增 progress，不结束步骤。requirements、criteria、readings 各自使用自己的稳定身份，不能互相替代。',
  'verification.finish':
    '声明当前步骤已完成，补交 progress 和执行证据。setup 仍须通过程序条件检查，缺少证据不能完成。',
  'verification.block':
    '保存已有 progress 并说明具体缺失前提或证据；不把阻塞写成产品验收失败。',
  'verification.intervene':
    '在任务授权范围内请求人工处理具体事项；人工确认只支持指定前置条件，不能代替业务验收。',
};

/** 附件标识与观察标识分开，避免模型将页面观察编号误当证据。 */
export const EVIDENCE_REFS_DESCRIPTION =
  '只复制列出的附件 ID；observationId 不是证据，不得改写或猜测 UUID。';
