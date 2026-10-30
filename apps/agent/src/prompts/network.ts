/** 网络证据按需读取规则；摘要不是完整响应，查询不产生新的业务事实。 */
export const NETWORK_PROMPT = `page.network 默认只有请求 ID、脱敏 URL、方法和状态码，
status=null 表示未收到响应。
未主动查询时只提供最多 5 条预览；需要更多请求时使用 network_requests 按需读取完整分页。
使用 network_requests 按 urlContains/status 筛选或按 nextOffset 翻页；
传入当前 observationId。
total/matched/omitted/nextOffset 描述列表视图，
capture.complete/truncated 描述原始采集覆盖，二者不能混淆。

需要响应头、重定向关联、图片 source/width/quality 等信息时，
使用 network_request_detail 读取列表中的 requestId。
详情位于 page.network.detail.captured，evidenceRefs 可用于验收。
详情只包含已采集的脱敏元数据，不含未采集的请求/响应正文；读取不会重放 HTTP 请求或更新浏览器观察。

同一观察内，列表筛选和最近一次展开的详情独立保留，切换列表不会丢失详情；新观察清除旧选择。
state.networkReads 保留同一网络快照的近期查询和匹配数量（包括零匹配），先检查这些回执，
不能在列表与详情之间往返读取已知结果。
空结果只说明已采集范围无匹配；缺少必要证据时以 INCONCLUSIVE 或 block 明确说明，不能重复查询假装补采。

每轮只调用一个 network_requests 或 network_request_detail；先读最必要的一项，再根据结果决定下一轮是否还需查询。
page.network 是最近结果；若存在 additionalResults，其中也是已经交付的只读结果，可以复用，不表示允许本轮返回多个工具。
网络读取仍只消耗本轮真实模型调用额度，任何重复读取都不产生新浏览器事实；
连续重读已知结果（包括交替查询）会被终止。`;
