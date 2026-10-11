// 固定登录配方只接受节点私有参数；在任何字段写入前核对文档与表单目标。
function (origin, recipe, clear) {
  if (location.origin !== origin) return false;
  const user = document.querySelector(recipe.usernameSelector);
  const pass = document.querySelector(recipe.passwordSelector);
  const submit = document.querySelector(recipe.submitSelector);
  if (!user || !pass || !submit || pass.type !== 'password' || user.type === 'password') return false;
  if (clear) { pass.value = ''; return true; }
  const form = pass.form;
  if (!form || user.form !== form || (submit.form && submit.form !== form)) return false;
  const action = submit.getAttribute('formaction') || form.action || location.href;
  if (new URL(action, location.href).origin !== origin || (form.target && !['_self', '_top'].includes(form.target))) return false;
  if ([user, pass, submit].some(el => el.disabled || !el.getClientRects().length)) return false;
  for (const [element, value] of [[user, recipe.username], [pass, recipe.password]]) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, value);
    element.dispatchEvent(new Event('input', {bubbles: true}));
    element.dispatchEvent(new Event('change', {bubbles: true}));
  }
  submit.click();
  return true;
}
