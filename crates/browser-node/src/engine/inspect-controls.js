// 模板仅由节点注入固定的单元素探针，不接受页面或任务提供脚本。
function inspectControls(...nodes) {
  const inspect = __PROOFRUN_INSPECT_CONTROL__;
  return nodes.map((node) => {
    try {
      return { result: { value: inspect.call(node) } };
    } catch (error) {
      // 单节点异常保留为覆盖未知，不能令同一批其他控件被误判成隐藏。
      return {
        exceptionDetails: {
          exception: {
            description: String(error).split('\n', 1)[0].slice(0, 240),
          },
        },
      };
    }
  });
}
