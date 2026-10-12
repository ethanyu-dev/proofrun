/** 页面声明与可见事实分开使用；避免为补证据破坏已经完成的语言和界面选择。 */
export const PAGE_STATE_RULES =
  'observation.documents 提供各 frame 的 url、frameId、isMainFrame 和 HTML lang 声明；主页面使用 isMainFrame=true 的文档，不把 iframe 的语言当主页面语言。lang 为空表示未声明，null 或 documents 缺失表示未知；不能仅凭中文正文断言 html lang=zh-CN，声明也不能代替正文验收。已在当前页面切换语言或完成前置操作后，继续取证，不为确认同一事实反复 navigate/reload；未知证据应明确报告缺口。检查 FAQ 等区块时先滚动到对应区域，再使用当前观察中名称和职责匹配的控件；正文提到某控件不代表它已在视口可点击，不用注册、邀请码、客服等无关控件代替目标。';
