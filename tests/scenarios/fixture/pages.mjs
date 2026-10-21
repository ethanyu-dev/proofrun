/** 页面脚本不接触管理接口、隐藏验证码或测评分数。用户输入只用 textContent 展示。 */
const SCRIPT = `
const base = location.pathname;
const group = new URL(location.href).searchParams.get('group') || 'main';
const status = document.getElementById('status');
async function call(action, data = {}) {
  const response = await fetch(base + '/action', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({action, group, ...data})});
  if (!response.ok) throw Error('服务暂时不可用');
  return response.json();
}
async function show(action, data) {
  try { const result = await call(action, data); status.textContent = result.text; }
  catch { status.textContent = '请求失败，请检查记录，不能假定提交成功'; }
}
document.getElementById('query')?.addEventListener('click', () => show('query'));
document.getElementById('remove')?.addEventListener('click', () => show('delete'));
document.getElementById('save')?.addEventListener('click', async () => {
  status.textContent = '正在处理，请勿重复提交';
  await show('save', {value:document.getElementById('value').value, notify:!!document.getElementById('notify')?.checked});
});
document.getElementById('value')?.addEventListener('blur', () => {
  if (document.body.dataset.kind === 'validation') show('validate', {value:document.getElementById('value').value});
});
document.getElementById('choose')?.addEventListener('click', () => show('select', {value:document.getElementById('choice').value}));
for (const panel of document.querySelectorAll('details')) panel.addEventListener('toggle', async () => {
  if (panel.open) { const result = await call('panel', {value:panel.id}); panel.querySelector('p').textContent = result.text; }
});
document.getElementById('next')?.addEventListener('click', () => {
  document.getElementById('first').hidden = true;
  document.getElementById('second').hidden = false;
});
document.getElementById('login')?.addEventListener('click', () => show('login', {value:document.getElementById('code').value}));
const list = document.getElementById('cities');
if (list) {
  const render = () => {
    const start = Math.max(0, Math.floor(list.scrollTop / 48) - 1);
    const layer = document.getElementById('rows'); layer.replaceChildren();
    for (let i=start; i<Math.min(50,start+8); i++) {
      const button = document.createElement('button');
      button.textContent = i===39 ? '第 40 项 Harbor' : '第 '+(i+1)+' 项 城市 '+(i+1);
      button.style.cssText = 'position:absolute;left:0;top:'+(i*48)+'px;height:44px;width:100%';
      button.onclick = () => show('select', {value:'city-'+(i+1)}); layer.append(button);
    }
  };
  list.addEventListener('scroll', render); render();
}
`;

/** 固定布局仅供协议人工输入脚本使用；真实 Console 布局须另行验收。 */
const STYLE = `body{font:18px system-ui;margin:24px;max-width:850px}input,select,button{font:inherit;padding:8px;margin:8px}button{cursor:pointer}details{padding:12px}#cities{height:240px;width:450px;overflow:auto;border:1px solid}#rows{height:2400px;position:relative}#code{position:absolute;left:24px;top:64px;width:260px;height:36px;margin:0}#login{position:absolute;left:24px;top:124px;height:44px;margin:0}.human-status{margin-top:170px}`;

/** HTML 仅使用目录内固定枚举；运行身份和隐藏真值不会插入脚本。 */
export function page(kind, group = 'main') {
  const query = '<button id="query">查询记录</button>';
  let content;
  if (kind === 'panels')
    content =
      '<details id="delivery"><summary>配送时效</summary><p></p></details><details id="refund"><summary>退款方式</summary><p></p></details>';
  else if (kind === 'select')
    content =
      '<label>配送地点<select id="choice"><option value="">请选择</option><option value="east">Harbor（东区）</option><option value="west">Harbor（西区）</option></select></label><button id="choose">确认选择</button>' +
      query;
  else if (kind === 'virtual')
    content =
      '<div id="cities" role="region" aria-label="城市列表"><div id="rows"></div></div>' +
      query;
  else if (kind === 'guest') content = '<p>当前身份：访客</p>';
  else if (kind === 'human')
    content =
      '<label>人工验证码<input id="code" aria-label="人工验证码" autocomplete="off"></label><button id="login">验证登录</button><div class="human-status">验证码由人工处理者持有，请请求人工协助。</div>' +
      query;
  else if (kind === 'wizard')
    content =
      '<div id="first"><label>项目名称<input id="value"></label><button id="next">下一步</button></div><div id="second" hidden><label><input type="checkbox" id="notify">启用通知</label><button id="save">保存配置</button></div>' +
      query;
  else
    content = `<label>${kind === 'validation' ? '邮箱' : '名称'}<input id="value" ${kind === 'validation' ? 'type="email"' : ''}></label><button id="save">保存</button>${query}${kind === 'cleanup' ? '<button id="remove">删除记录</button>' : ''}`;
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>业务测试应用</title><style>${STYLE}</style><body data-kind="${kind}"><h1>${kind === 'groups' ? (group === 'alpha' ? '甲组' : '乙组') : '业务测试应用'}</h1>${content}<p id="status" role="status">尚未操作</p><script>${SCRIPT}</script></body></html>`;
}
