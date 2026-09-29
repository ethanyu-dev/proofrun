// 仅在真实 frame 的隔离上下文执行；不信任页面主世界改写的文档归属或 DOM 原型。
function inspectControl(wheelScroll = false) {
  // 函数被 CDP 独立序列化执行，限额必须在函数内声明，不能依赖外部闭包。
  const REGION_DEPTH_LIMIT = 64;
  const REGION_ANCESTORS_LIMIT = 4;
  const REGION_NAME_CHARS = 160;
  const el = this;
  const doc = el.ownerDocument;
  const win = doc.defaultView;
  const parent = (node) => node.parentElement || node.getRootNode()?.host;
  const rect = el.getBoundingClientRect();
  let left = Math.max(0, rect.left),
    top = Math.max(0, rect.top);
  let right = Math.min(win.innerWidth, rect.right),
    bottom = Math.min(win.innerHeight, rect.bottom);
  let reason = !el.isConnected
    ? 'detached'
    : rect.width <= 0 || rect.height <= 0
      ? 'no_layout'
      : null;
  let inert = false,
    ariaHidden = false,
    ariaDisabled = false;
  if (!reason && (right <= left || bottom <= top)) reason = 'outside_viewport';
  for (let node = el; node; node = parent(node)) {
    const style = win.getComputedStyle(node);
    inert ||= node.hasAttribute('inert');
    ariaHidden ||= node.getAttribute('aria-hidden') === 'true';
    ariaDisabled ||= node.getAttribute('aria-disabled') === 'true';
    // visibility 可由后代显式恢复，opacity/display 则受真实祖先影响。
    if (style.display === 'none') reason ||= 'display_none';
    if (node === el && ['hidden', 'collapse'].includes(style.visibility))
      reason ||= 'css_visibility';
    if (Number(style.opacity) === 0) reason ||= 'transparent';
    if (node !== el) {
      const r = node.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
        left = Math.max(left, r.left);
        right = Math.min(right, r.right);
      }
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
        top = Math.max(top, r.top);
        bottom = Math.min(bottom, r.bottom);
      }
    }
  }
  if (!reason && (right <= left || bottom <= top)) reason = 'ancestor_clip';
  // 同源父框的隐藏和裁剪也影响可见性；跨域边界仍由动作命中检查兜底，覆盖范围明确标成 frame。
  const frame = win.frameElement;
  if (frame) {
    const outer = inspectControl.call(frame);
    const frameRect = frame.getBoundingClientRect();
    const sx = frameRect.width / frame.offsetWidth || 1;
    const sy = frameRect.height / frame.offsetHeight || 1;
    if (!outer.visible) reason ||= 'parent_frame_hidden';
    inert ||= outer.inert;
    left = Math.max(
      left,
      (outer.clip.left - frameRect.left) / sx - frame.clientLeft,
    );
    right = Math.min(
      right,
      (outer.clip.right - frameRect.left) / sx - frame.clientLeft,
    );
    top = Math.max(
      top,
      (outer.clip.top - frameRect.top) / sy - frame.clientTop,
    );
    bottom = Math.min(
      bottom,
      (outer.clip.bottom - frameRect.top) / sy - frame.clientTop,
    );
  }
  if (!reason && (right <= left || bottom <= top)) reason = 'parent_frame_clip';
  const style = win.getComputedStyle(el);
  const scrollX =
    (/(auto|scroll)/.test(style.overflowX) ||
      (wheelScroll && style.overflowX === 'hidden')) &&
    el.scrollWidth > el.clientWidth;
  const scrollY =
    (/(auto|scroll)/.test(style.overflowY) ||
      (wheelScroll && style.overflowY === 'hidden')) &&
    el.scrollHeight > el.clientHeight;
  const disabled = inert || el.matches(':disabled') || ariaDisabled;
  const editable =
    !el.readOnly &&
    el.getAttribute('aria-readonly') !== 'true' &&
    (el.isContentEditable ||
      el.tagName === 'TEXTAREA' ||
      (el.tagName === 'INPUT' &&
        [
          'text',
          'password',
          'email',
          'url',
          'tel',
          'search',
          'number',
        ].includes(el.type)));
  const label = (el.getAttribute('aria-labelledby') || '')
    .split(/\s+/)
    .map((id) => el.getRootNode().getElementById?.(id)?.textContent || '')
    .filter(Boolean)
    .join(' ')
    .trim();
  // 区域来自真实 composed 祖先；portal 没有可证实的所属关系时保留未知，不猜关联。
  let region = null;
  for (let node = el; node; node = parent(node)) {
    const role =
      node.getAttribute('role') ||
      {
        form: 'form',
        dialog: 'dialog',
        main: 'main',
        nav: 'navigation',
        aside: 'complementary',
      }[node.localName];
    if (
      ![
        'form',
        'dialog',
        'alertdialog',
        'listbox',
        'menu',
        'main',
        'navigation',
        'region',
        'search',
      ].includes(role)
    )
      continue;
    const regionName =
      node.getAttribute('aria-label') ||
      (node.getAttribute('aria-labelledby') || '')
        .split(/\s+/)
        .map((id) => node.getRootNode().getElementById?.(id)?.textContent || '')
        .join(' ')
        .trim() ||
      node.getAttribute('name') ||
      node.id ||
      role;
    if (region) {
      region.ancestors.push({
        role,
        name: regionName.slice(0, REGION_NAME_CHARS),
      });
      if (region.ancestors.length >= REGION_ANCESTORS_LIMIT) break;
      continue;
    }
    const path = [];
    let ancestor = node;
    // 有界路径仅作区域排序身份；超深结构保留语义名称但不伪造唯一身份。
    for (
      let i = 0;
      ancestor && i < REGION_DEPTH_LIMIT;
      i++, ancestor = parent(ancestor)
    ) {
      let index = 0;
      for (
        let sibling = ancestor.previousElementSibling;
        sibling;
        sibling = sibling.previousElementSibling
      )
        index++;
      path.push(ancestor.localName + ':' + index);
    }
    region = {
      key: ancestor ? null : path.reverse().join('/'),
      role,
      name: regionName.slice(0, REGION_NAME_CHARS),
      ancestors: [],
    };
  }
  return {
    region,
    // overflow:hidden 的虚拟列表只有确认存在 wheel 监听后才提供滚动能力。
    wheelCandidate:
      (style.overflowY === 'hidden' && el.scrollHeight > el.clientHeight) ||
      (style.overflowX === 'hidden' && el.scrollWidth > el.clientWidth),
    connected: el.isConnected,
    tag: el.localName,
    visible: !reason,
    visibilityReason: reason || 'in_viewport',
    inert,
    ariaHidden,
    // 含独立语义控件的通用监听容器通常是事件委托入口，不是一个业务按钮。
    delegatedContainer: !!el.querySelector(
      'button,input,textarea,select,a[href],[role="button"],[role="menuitem"],[role="combobox"],[role="option"]',
    ),
    visibilityScope: 'frame',
    clip: { left, top, right, bottom },
    disabled,
    editable,
    label: label.slice(0, 512),
    expanded: el.getAttribute('aria-expanded'),
    selected: el.getAttribute('aria-selected'),
    checked: ['checkbox', 'radio'].includes(el.type)
      ? el.checked
      : el.getAttribute('aria-checked'),
    activeRegion: !!el.closest(
      'dialog[open],[role="dialog"],[role="listbox"],[role="menu"]',
    ),
    scroll:
      scrollX || scrollY
        ? {
            x: el.scrollLeft,
            y: el.scrollTop,
            width: el.clientWidth,
            height: el.clientHeight,
            scrollWidth: el.scrollWidth,
            scrollHeight: el.scrollHeight,
          }
        : null,
    // 比例坐标由 CDP 内容四边形转换至当前会话视口，避免同进程 iframe 的局部坐标误用。
    point: {
      x: ((left + right) / 2 - rect.left) / rect.width,
      y: ((top + bottom) / 2 - rect.top) / rect.height,
    },
  };
}
