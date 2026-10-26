#!/usr/bin/env python3
"""真实 session-host/固定引擎的动画偏好回归。

覆盖首次脚本、iframe 与新标签页；使用本地 HTML，不代表线上 GPU 性能或 Linux cgroup 验收。
"""
import json
import os
from pathlib import Path
import queue
import subprocess
import tempfile
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# 首个内联脚本立即读取偏好，避免导航后再修改掩盖初始化时序错误。
HTML = b'''<!doctype html><meta charset="utf-8"><title>Motion fixture</title>
<p id="motion"></p><p id="frame"></p><script>
const motion = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduce' : 'normal';
document.querySelector('#motion').textContent = motion;
if (window !== parent) parent.postMessage(motion, location.origin);
else {
  addEventListener('message', e => {
    if (e.origin === location.origin) document.querySelector('#frame').textContent = e.data;
  });
  const frame = document.createElement('iframe'); frame.src = '/frame'; document.body.append(frame);
}
</script>'''


class Fixture(BaseHTTPRequestHandler):
    """只提供固定回环页面，不读取生产网站或身份材料。"""
    def log_message(self, *_):
        pass

    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.end_headers()
        self.wfile.write(HTML)


def check(engine, chrome, binary, url, preference):
    """省略、开启、关闭分别使用独立 profile；通过适配器命令验证，而非只读配置文件。"""
    expected = 'normal' if preference is False else 'reduce'
    with tempfile.TemporaryDirectory(prefix='proofrun-motion-') as directory:
        root = Path(directory)
        session = uuid.uuid4().hex
        config = {'binary': engine, 'chrome': chrome, 'session': session,
                  'directory': directory, 'allow_unverified_writes': True}
        if preference is not None:
            config['reduced_motion'] = preference
        messages = queue.Queue()
        with (root / 'stderr.log').open('w') as log:
            process = subprocess.Popen([binary, 'session-host', '--directory', directory],
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log,
                                       text=True, bufsize=1)
            def read():
                for line in process.stdout:
                    messages.put(json.loads(line))
                messages.put(None)
            threading.Thread(target=read, daemon=True).start()

            def receive():
                try:
                    value = messages.get(timeout=40)
                except queue.Empty:
                    raise AssertionError((root / 'stderr.log').read_text())
                assert value is not None, (root / 'stderr.log').read_text()
                return value

            def send(value):
                process.stdin.write(json.dumps(value) + '\n')
                process.stdin.flush()

            def command(**value):
                send({'type': 'run', 'command': value, 'timeout_ms': 15000})
                response = receive()
                assert response['type'] == 'host.result', response
                assert 'Ok' in response['result'], response
                return response['result']['Ok']

            try:
                assert receive()['type'] == 'host.ready'
                boot = int(float(Path('/proc/uptime').read_text().split()[0]) * 1000) if Path('/proc/uptime').exists() else 0
                send({'type': 'init', 'config': config, 'deadline_ms': boot + 180000,
                      'startup_deadline_ms': boot + 60000})
                opened = receive()
                assert 'Ok' in opened['result'], opened
                assert opened['result']['Ok']['environmentProof']['reducedMotion'] == (preference is not False)
                # 范围：首次导航、再次导航及引擎创建的新标签页继承相同偏好，不覆盖 GPU 性能。
                for action in ('navigate', 'navigate', 'tab.new'):
                    command(type='browser.act', action=action, target=url)
                    command(type='browser.wait', selector='#motion', text=expected)
                    command(type='browser.wait', selector='#frame', text=expected)
                print(f'PASS reduced_motion={preference}: first script / navigation / iframe / new tab / proof', flush=True)
            finally:
                if process.poll() is None:
                    process.stdin.close()
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=5)
                # 仅关闭本次独立引擎会话，不按进程名影响其它浏览器。
                try:
                    subprocess.run([engine, '--session', session, 'close'],
                                   env={**os.environ, 'HOME': str(root / 'home'),
                                        'AGENT_BROWSER_SOCKET_DIR': f'/tmp/proofrun-{os.getuid()}/{session}'},
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=8)
                except subprocess.TimeoutExpired:
                    pass


if __name__ == '__main__':
    binary = str(Path(os.environ.get('PROOFRUN_TEST_BINARY', 'target/debug/proofrun-node')).resolve())
    engine = str(Path(os.environ['PROOFRUN_AGENT_BROWSER_BIN']).resolve())
    chrome = str(Path(os.environ['PROOFRUN_CHROME_BIN']).resolve())
    server = ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        for preference in (None, True, False):
            check(engine, chrome, binary, f'http://127.0.0.1:{server.server_port}', preference)
    finally:
        server.shutdown()
        server.server_close()
