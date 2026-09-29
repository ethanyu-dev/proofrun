# 2026-09-28 白名单重跑分析

对象：`rerun-a2e73c38-7b93-4017-8359-b87a5c8bfebc` 的 LLM 与 JEV 两组。只读取任务、模型调用、截图和站点公开静态资源，并执行独立 Chromium 机制复现；没有修改业务数据或重新启动任务。

## 结果

| 项目                         | LLM                                    | JEV                                    |
| ---------------------------- | -------------------------------------- | -------------------------------------- |
| 执行 ID                      | `03401323-e9d9-4f76-8ec3-7712e3ff18a2` | `c17a9a72-666e-49ba-8c0c-3fb4656736d6` |
| 开始时间（北京时间）         | 14:51:09                               | 14:51:09                               |
| 完成时间（北京时间）         | 14:53:49                               | 14:56:06                               |
| 执行器耗时，含人工等待       | 158.331 秒                             | 294.375 秒                             |
| 平台记录动作数，包含人工操作 | 11                                     | 11                                     |
| 模型调用                     | 12 次文本模型                          | 24 次 JEV + 21 次文本模型              |
| 输入 / 输出 token            | 123,827 / 974                          | 544,606 / 4,613                        |
| 结果                         | BLOCKED / NO_PROGRESS                  | BLOCKED / NO_PROGRESS                  |

两组 task.state 都是 COMPLETED，含义是任务执行已结束，不是业务验收通过。report.verdict 为 null，唯一验收项为 SKIPPED；两个浏览器会话均 CLOSED 且 closure_verified=true。人工登录已经完成，最终页面是白名单配置页；不能把残留的 control_reason 登录说明误当最终失败原因。

## 已确认的直接原因：业务区控件在采集层丢失

LLM 第 7 次调用对应截图中，搜索输入框、白名单类型下拉、搜索/重置、新增白名单和下拉选项均真实显示。对应结构化 targets 却只有 9 个：一个大范围 div、7 个顶部 menuitem、一个用户菜单 div。搜索控件、下拉选项及其滚动容器全部缺失。

该轮覆盖记录：controls.total=9、returned=9、omitted=0、outsideViewportOrHidden=97；正文和执行器上下文均未裁剪。JEV 白名单页面的 22 次 JEV 请求也都是 9 个动作候选、0 个候选省略。因此本次故障发生在候选生成之前，与 80/200 动作上限或 token 预算无关。

具体调用链：`inspect-control.js` 返回不可见或未返回有效 facts → `dom.rs` 的 `facts["visible"] != true` 将其计入 outsideViewportOrHidden 并丢弃 → 差分和 JEV 只能比较/选择剩余的顶部导航。

## 根因机制：Wujie 重写的文档归属不等于实际渲染归属

该站点当前公开入口 `/static/js/main.818cfff9.js` 中，product-ops 的 type 为 wujie；沙箱 iframe 使用 display:none；patchElementEffect 对元素定义 ownerDocument getter，返回沙箱 window.document。Wujie 在 Shadow DOM 中展示子应用，同时通过 iframe 隔离执行环境；上游也有对应的 ownerDocument 与 getRootNode 改写实现：[Wujie iframe.ts](https://github.com/Tencent/wujie/blob/master/packages/wujie-core/src/iframe.ts)。分析以站点实际 bundle 为依据，不假设它与上游 master 完全一致。

新探针在第 4–5 行直接读取 `el.ownerDocument.defaultView`，又在第 35–41 行通过该 window.frameElement 递归判断父框。遇到上述重写后，真实可见的子应用控件会被当作属于隐藏的沙箱 iframe。这是上一轮修改引入的兼容性回归；普通 Shadow DOM 和 iframe 的既有回归夹具没有覆盖这类属性重写。

独立 Chromium 最小复现：在主文档 Shadow DOM 内放置一个可见按钮，仅把 ownerDocument 重定向到 display:none iframe 的 document。未重写时探针 visible=true，重写后 visible=false；按钮实际矩形仍为 x=8、y=8、width=150、height=40；原生 Node.prototype.ownerDocument getter 仍返回主文档。复现说明机制成立，结合真实任务的截图、目标缺失和站点 bundle，根因证据一致。原任务会话已关闭，不能把这个夹具称为对原始节点的现场重采样。

## 逐轮行为及其他问题

- LLM 人工登录后借助视觉点击进入白名单配置，并在第 6 次决策展开搜索下拉。第 7–10 次连续 observe，第 11 次按 End，第 12 次再次 observe；没有产生定向 scroll。公共执行器在第 6 个无变化观察后阻塞退出。
- JEV 第 13 次模型调用把“包含整页汇总文字的 dom-1”排到 A1 并点击。这证明变化优先生效，但根容器随子树变化而改名，占据了真实变化控件本应得到的位置；截图/后续观察显示下拉随之关闭。
- JEV 反复 REPLAN → LLM observe。每次 review 后清除局部停滞计数，下一轮又进行 JEV 调用，因此产生 45 次调用。公共停滞计数没有被清除，最终仍成功止损；但打开/关闭下拉等状态变化会重新计数，尚未检测 A→B→A 循环。
- coverage 的 omitted=0 只说明通过筛选的目标没有再次裁剪。当前把不可见、探针异常、文档归属问题合并为 outsideViewportOrHidden，模型无法识别“页面明明可见但采集失败”。
- 正文里出现两个目标类型并不证明下拉选项验收通过：表格数据行也包含这些名字。必须绑定搜索下拉/新增弹窗的具体范围取证。
- 任务 objective 有五步，但 acceptanceCriteria 只有“搜索下拉两个选项”一项且只要求 DOM。新增弹窗、两个类型的默认启用状态、截图和关闭不提交没有独立的结构化验收项。

## 建议修复顺序

1. 修正渲染归属：优先使用 CDP 对应的真实 frame、文档与隔离执行上下文；只读探针使用可靠原生 getter/方法，避免将页面重写的 ownerDocument、getRootNode 当作浏览器事实。不要为 Wujie 页面直接关闭可见性过滤。
2. 让采集失败可诊断：区分无布局、视口外、实际裁剪、隐藏、inert 和探针异常，记录有界原因和出错的祖先/frame。无法确定时标记 unknown，可重新采集；不直接宣称目标不存在。
3. 排除框架事件委托根容器：isClickable 表示存在监听，不保证这个大容器本身是有明确业务语义的控件。避免用整棵子树文本作为根 div 的名字和变化评分。
4. 扩大真实 Chromium 验证范围：加入 Wujie 式 ownerDocument/getRootNode 重写、隐藏沙箱与可见 Shadow DOM、portal 弹层等。验证输入框、下拉选项、滚动容器、新增按钮都被采集且对应截图。
5. 补充状态循环检测和恢复动作约束：同一状态反复 REPLAN/observe 不再重复付出双模型调用；明确触发采集诊断、不同恢复动作或人工处理。
6. 补齐五步验收项后重跑，确认搜索下拉和新增弹窗两个范围的目标类型、默认开关状态、截图及无提交行为。下文记录本轮修复与验证，完整任务仍需独立重跑。

## 本轮修复与验证

- 原生 DOM 仍经现有 agent-browser/CDP 链路采集。以 Chromium 的真实 frame 创建隔离上下文，读取布局、文档归属、节点状态并执行绑定节点的动作；避免 Wujie 主世界改写影响。导航后旧观察和隔离节点引用失效。
- 可见但 inert/disabled 的控件保留证据、禁止操作。隐藏、视口外、祖先裁剪分别计数；探针异常单独记录 inspectionErrors 和最多 5 个错误首行，不再冒充隐藏。CSS 伪元素不能作为独立 DOM 控件，提前排除。
- 排除含语义子控件的通用事件委托根。真实滚动容器只获得 scroll 能力，不能仅因注册事件就成为大范围点击目标。
- 额外支持 overflow:hidden、实际溢出且自身绑定 wheel/mousewheel 的虚拟列表。通过 CDP 查询页面主世界监听器元数据，几何与动作仍使用隔离上下文；普通 hidden 裁剪不会因此获得滚动能力。祖先委托监听和纯 transform 位移不在此次覆盖内。
- 保留最多 20,000 字符的 agent-browser 原始语义快照作为 referenceSnapshot，连同 coverage 写入 DOM 证据。其 refs 只供诊断，不与原生 target 混合授予动作权限。

验证包括 Rust 19 项测试、Agent 47 项测试、API 类型检查及新增证据保存测试；独立真实 Chromium 夹具覆盖隐藏沙箱、关闭 Shadow DOM、ownerDocument/getRootNode/几何方法改写、原生动作、虚拟滚轮、普通裁剪反例、委托根排除、导航失效与伪元素。夹具不加载完整 Wujie，也不代替真实业务验收。

另外使用独立浏览器会话和认证副本，只读检查原白名单页面：业务区控件从原任务的 9 个恢复到加载稳定后的 32 个；搜索框、类型下拉与新增按钮可见。展开搜索下拉后识别到 rc-virtual-list-holder（height=256、scrollHeight=576）；原生目标滚动从 y=0 到 y=320，展开及滚动后的 inspectionErrors 均为 0，重新观察获得“合规模型映射”和“旧版对公转账白名单”两个可见选项目标。未选择选项、未新增/提交业务数据；关闭诊断会话并清理认证副本。

这证明当前站点的采集、下拉点击和虚拟列表定向滚动链路已恢复；不代表 LLM/JEV 已完成整套五步验收。跨域父框裁剪仍标记未知，重复 REPLAN/observe 与 A→B→A 循环优化、按范围补全接口也未在本轮实现。

部署：2026-09-28 15:25（Asia/Shanghai）重新构建并重启本地 API、浏览器节点与 Agent。更新前任务队列无运行项；API ready、三项服务 active、节点新 epoch 上线且 occupied=0。浏览器进程使用重新构建的运行二进制。原模型任务未自动重跑。
