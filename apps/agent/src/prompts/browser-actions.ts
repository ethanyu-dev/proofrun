/** 子动作规则随最终 action 枚举进入工具说明；未开放的动作不占用提示词。 */
export const BROWSER_ACTION_PROMPTS: Record<string, string> = {
  navigate: `不为确认同一事实反复 navigate。
task.url 是访问入口，不能自行增加最终地址必须等于入口的要求。
当前要求已经满足时保存证据并 finish，不因 URL 外观重新导航。
需要切换语言时使用页面提供的语言控件或真实链接，不猜测语言路径；
若导航撤销了已达成的状态，依据历史恢复有效操作，不重复同一导航。`,
  press: '按键 scope 与 focusVerified 只证明派发前焦点，不证明业务校验成功。',
  select: '原生 select 与自定义下拉不同，后者需展开后选择真实选项。',
  scroll: `scroll 指定 target 时必须是当前滚动容器，无 target 滚动页面。
value 只填 up、down、left、right，不传像素数或 top/bottom；
滚动距离由执行器根据当前视口计算，历史回执里的方向加像素数不能作为工具参数。`,
  'visual.click': '视觉点击仅使用本轮交付截图的视口 CSS 坐标。',
  online: 'online 只派发一次 online 事件。',
  'pwa.cleanup': 'pwa.cleanup 仅清理阶段清理当前 origin 的 SW 与缓存。',
  'network.probe': `network.probe 的 target 仅允许当前页面已观察的同源 /_next/image URL 参数变体，
结果明确为不携带登录凭据的公开请求。
图片探测只能采用真实观察到的优化图片参数，不能根据普通图片路径拼造请求。`,
};
