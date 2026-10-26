function focusForPress() {
  // getRootNode 同时支持普通文档与 Shadow DOM；文档焦点与元素焦点分开诊断。
  this.focus({ preventScroll: true });
  const connected = this.isConnected;
  const active = this.getRootNode().activeElement === this;
  const documentFocused = this.ownerDocument.hasFocus();
  return {
    connected,
    active,
    documentFocused,
    verified:
      connected && !this.matches(':disabled') && active && documentFocused,
  };
}
