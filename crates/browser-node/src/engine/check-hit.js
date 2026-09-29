function checkHit(hit) {
  // 普通控件仍只接受自身与组合树后代；外部遮罩不能借公共祖先获得点击许可。
  for (let n = hit; n; n = n.parentNode || n.host) {
    if (n === this) return true;
  }
  // 复合下拉的输入与选值展示层常为兄弟节点。只检查两层局部包装，
  // 且要求唯一交互控件、紧贴输入的布局和非交互展示层，不依赖业务名或 CSS 类名。
  if (this.localName !== 'input' || this.getAttribute('role') !== 'combobox')
    return false;
  const interactive =
    'input,textarea,select,button,a[href],[role]:not([role="presentation"]):not([role="none"]),[tabindex],[contenteditable="true"]';
  const r = this.getBoundingClientRect();
  let owner = this.parentElement;
  for (
    let depth = 0;
    owner && depth < 2;
    depth++, owner = owner.parentElement
  ) {
    if (owner.matches('body,html,form,dialog') || owner.matches(interactive))
      break;
    if (!owner.contains(hit)) continue;
    const controls = owner.querySelectorAll(interactive);
    const b = owner.getBoundingClientRect();
    if (
      controls.length !== 1 ||
      controls[0] !== this ||
      b.width > r.width * 1.5 ||
      b.height > r.height * 2 ||
      r.width <= 0 ||
      r.height <= 0 ||
      Math.abs(b.left - r.left) > 4 ||
      Math.abs(b.top - r.top) > 4
    )
      return false;
    for (let n = hit; n && n !== owner; n = n.parentElement) {
      if (
        !(n instanceof Element) ||
        n.matches(interactive) ||
        n.onclick ||
        n.onmousedown ||
        n.onpointerdown
      )
        return false;
    }
    return true;
  }
  return false;
}
