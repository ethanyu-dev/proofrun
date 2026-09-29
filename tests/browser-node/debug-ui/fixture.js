// 本地测试页只改变页面文本，用于肉眼核对 Browser Node 点击后的快照和截图。
let clicks = 0;
document.getElementById('save').addEventListener('click', () => {
  clicks += 1;
  const name = document.getElementById('name').value;
  document.getElementById('result').textContent =
    `已保存：${name || '(空)'}；点击次数：${clicks}`;
});
