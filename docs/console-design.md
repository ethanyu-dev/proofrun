# Console 设计与组件约定

控制台是管理员操作台，按 AGENTS.md 保持简单、紧凑的布局。导航、表单、任务事实和验证证据优先，不添加营销式大标题、装饰性动效或多余的卡片层级。

## 组件与模块

采用 [shadcn/ui](https://ui.shadcn.com/) 的 Radix 组件和 [Sonner](https://ui.shadcn.com/docs/components/radix/sonner)。基础源码来自官方 new-york-v4 注册表，保留 MIT 许可证，并适配中文文案及项目主题。不为装饰性动画同时引入第二套组件库。

| 模块                                    | 职责                                                         |
| --------------------------------------- | ------------------------------------------------------------ |
| `apps/console/components.json`          | shadcn 组件目录、样式入口和别名配置                          |
| `src/components/ui/`                    | Button、Input、Textarea、Select、Dialog、Tabs、Badge、Sonner |
| `src/components/select-field.tsx`       | 统一下拉可访问名称、浮层位置和业务选项                       |
| `src/components/modal.tsx`              | 受控弹窗、请求期间关闭保护、焦点归还                         |
| `src/components/ui.tsx`                 | 业务状态、页标题、空状态、错误和刷新状态                     |
| `src/components/app-shell.tsx`          | 全局导航、连接状态、主要内容及跳转入口                       |
| `src/main.tsx`                          | 连接状态、页内路由、页面按需加载                             |
| `src/tokens.css`                        | 深浅主题、语义颜色、字体和尺寸                               |
| `src/components/ui/theme.css`           | 组件库工具类及语义变量映射                                   |
| `src/style.css`                         | 共享布局与执行详情样式                                       |
| `src/requests.css`、`src/dashboard.css` | 请求和看板专用布局                                           |

页面继续使用现有 API、轮询和协议状态，不在 UI 组件内创建任务调度、业务判定或请求重试逻辑。路由模块按需加载，连接页无需加载报告 Markdown、任务 JSON 校验和全部业务页面。

## 视觉约束

- 黑白灰为主，颜色只用于业务状态和错误；所有状态同时提供文字说明。
- 标题约 24–26px，正文以 14px 为基准，控件以 36px 为基准。表格、请求摘要和证据区保持紧凑。
- 面板及控件统一小圆角、细边框，常规内容不加重投影；浮层使用组件库阴影区分层级。
- 字体来自本机，无远端字体依赖。截图保持原色、原比例，主题切换不做图片反转。
- 宽屏导航保持单行；窄屏导航单独横向滚动，表单和多列业务区按各自断点收为单列。
- Tailwind 4 只加载主题及工具类，不启用全局 preflight，避免破坏报告正文、表格及原有证据排版。
- 颜色统一来自语义变量，Portal 菜单、弹窗和 Sonner 同样继承。尊重 `prefers-reduced-motion`。

## 交互约束

按钮和按钮式链接通过 `Button` 统一变体；链接保留原生导航、下载和新窗口语义。表单输入使用 `Input` / `Textarea`，继续保留 required、只读、长度、禁用和提交约束。

下拉使用 `SelectField`，不使用浏览器原生 select。菜单提供键盘导航、选择回显及可访问名称；空筛选使用专用界面值，提交查询前映射回空字符串。Radix 为表单同步生成的隐藏原生字段不作为用户交互入口。

取消任务、取消执行组、撤销节点和证据预览通过共享 Dialog 展示。确认操作默认聚焦返回按钮，支持 Escape 和关闭后焦点归还；请求进行中禁用关闭，避免隐藏未确认结果。错误保留在弹窗内，成功通知仅描述接口确认的事实，例如“取消请求已提交”，不声称浏览器已释放。

成功保存和复制使用 Sonner；持续错误、读取失败及需要恢复的信息继续在页面或表单中展示。不使用 `window.alert` 和 `window.confirm`。

任务提交版本使用 Tabs，提供键盘切换和关联面板语义，草稿由页面状态持有。切换版本不生成新任务身份。HITL 保持独立页面及原有远端输入约束，仅复用基础控件。

## 数据与验证边界

接口失败不能伪装为空结果；轮询失败保留上次成功数据和读取时间。状态、通过数和证据仍遵守现有协议，详见 [控制台 README](../apps/console/README.md)。

`pnpm test:console` 覆盖已有业务呈现与请求行为；`ui-controls.test.ts` 额外验证下拉键盘选择、空筛选、表单值、禁用状态和弹窗忙碌保护、焦点归还。`pnpm --filter @proofrun/console build` 检查 TypeScript 和生产构建。

DOM 测试及浏览器界面夹具不代表真实模型、节点、API 或站点业务验收。浏览器检查需分别核对深浅主题、菜单和弹窗定位、窄屏溢出、焦点可见及证据内容滚动。
