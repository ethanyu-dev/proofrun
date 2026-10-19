function focusForPress() {
  // getRootNode 同时支持普通文档与 Shadow DOM；hasFocus 核对所在文档和 iframe 焦点链。
  this.focus({ preventScroll: true });
  return (
    this.isConnected &&
    !this.matches(':disabled') &&
    this.getRootNode().activeElement === this &&
    this.ownerDocument.hasFocus()
  );
}
