#!/usr/bin/env python3
"""验证原生 agent-browser、真实 Chrome 与本地表单的直接 host 适配。

使用独立 profile 和回环页面，不经过节点网关或 Linux systemd/cgroup；
服务端计数只能证明本场景提交次数，不能证明响应丢失时不会被引擎重试。
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import tempfile
import threading
import time
import uuid

# 本地页面分别上报普通 DOM、Shadow DOM 与 iframe 的按键，不依赖浏览器关闭时的页面事件。
HTML = b'''<!doctype html><html><title>ProofRun engine fixture</title><body>
<div id="plain"></div><div id="outer"></div><p id="keyboard"></p>
<label>Redirect focus<input id="redirect"></label><script>
window.recordKey = (prefix, key) => navigator.sendBeacon('/keys', JSON.stringify({prefix, key}));
function form(root, prefix) {
  root.innerHTML = `<label>${prefix} name<input id="name"></label><button>Save ${prefix}</button><p role="status">Waiting</p>`;
  root.querySelector('button').onclick = async () => {
    const name = root.querySelector('input').value;
    const response = await fetch('/submit', {method:'POST', body:JSON.stringify({prefix, name})});
    root.querySelector('[role=status]').textContent = response.ok ? `Saved ${prefix} ${name}` : 'Failed';
  };
  root.querySelector('input').onkeydown = event => {
    window.recordKey(prefix, event.key);
    document.querySelector('#keyboard').textContent = `Key ${prefix} ${event.key}`;
  };
  root.querySelector('input').onblur = () => {
    document.querySelector('#keyboard').textContent += ` Blur ${prefix}`;
  };
}
form(document.querySelector('#plain'), 'Plain');
const first = document.querySelector('#outer').attachShadow({mode:'open'});
first.innerHTML = '<section></section>';
form(first.querySelector('section').attachShadow({mode:'open'}), 'Shadow');
document.querySelector('#redirect').onfocus = () => {
  document.querySelector('#keyboard').textContent = 'Focus redirected without key';
  document.querySelector('#plain input').focus();
};
const frame = document.createElement('iframe');
frame.title = 'Keyboard frame';
frame.srcdoc = `<label>Frame name<input onkeydown="parent.recordKey('Frame',event.key); parent.document.querySelector('#keyboard').textContent='Key Frame '+event.key" onblur="parent.document.querySelector('#keyboard').textContent+=' Blur Frame'"></label><button>After frame input</button>`;
document.body.append(frame);
</script></body></html>'''


class Fixture(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.end_headers()
        self.wfile.write(HTML)

    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        if self.path == '/keys':
            self.server.key_events.append(data)
        else:
            self.server.writes.append(data)
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'{}')


def run():
    """覆盖普通表单、两层 open Shadow DOM、观察目标、等待和 PNG 截图。"""
    binary = Path(os.environ.get('PROOFRUN_TEST_BINARY', 'target/debug/proofrun-node')).resolve()
    engine = Path(os.environ['PROOFRUN_AGENT_BROWSER_BIN']).resolve()
    chrome = Path(os.environ['PROOFRUN_CHROME_BIN']).resolve()
    root = Path(tempfile.mkdtemp(prefix='proofrun-real-engine-'))
    session = uuid.uuid4().hex
    server = ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
    server.writes = []
    server.key_events = []
    threading.Thread(target=server.serve_forever, daemon=True).start()
    log = (root / 'stderr.log').open('w')
    process = subprocess.Popen([str(binary), 'session-host', '--directory', str(root)],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, text=True, bufsize=1)
    messages = queue.Queue()
    def read():
        for line in process.stdout:
            messages.put(json.loads(line))
        messages.put(None)
    threading.Thread(target=read, daemon=True).start()

    def receive():
        message = messages.get(timeout=30)
        assert message is not None, (root / 'stderr.log').read_text()
        return message

    def send(message):
        process.stdin.write(json.dumps(message) + '\n')
        process.stdin.flush()

    def attempt(**operation):
        """保留失败回执供边界断言；未知效果仍由真实 host 按原规则关闭。"""
        send({'type': 'run', 'command': operation, 'timeout_ms': 15000})
        message = receive()
        assert message['type'] == 'host.result', message
        return message

    def command(**operation):
        message = attempt(**operation)
        assert 'Ok' in message['result'], message
        return message['result']['Ok']

    socket_dir = Path('/tmp') / f'proofrun-{os.getuid()}' / session
    known_pids = []
    try:
        # 真实引擎启动：只测试内部 session-host 管道与原生 CLI/Chrome。
        assert receive()['type'] == 'host.ready'
        # macOS 直接运行 host 时使用进程相对时间；Linux 使用系统启动后的时间。
        boot_ms = int(float(Path('/proc/uptime').read_text().split()[0]) * 1000) if Path('/proc/uptime').exists() else 0
        send({'type': 'init', 'config': {'binary': str(engine), 'chrome': str(chrome), 'session': session,
               'directory': str(root), 'allow_unverified_writes': True}, 'deadline_ms': boot_ms + 120000, 'startup_deadline_ms': boot_ms + 120000})
        opened = receive()
        assert 'Ok' in opened['result'], opened
        known_pids = [int(path.read_text()) for path in socket_dir.glob('*.pid')]
        assert known_pids, 'expected the native engine daemon PID before closure'
        # 页面操作：每次动作前重新观察，分别提交普通 DOM 与 open Shadow DOM 表单。
        # 独立 HTTP 服务记录字段和次数，避免只相信 CLI 成功标志。
        command(type='browser.act', action='navigate', target=f'http://127.0.0.1:{server.server_port}')
        for prefix, name in [('Plain', 'Ada'), ('Shadow', 'Lin')]:
            for role, label, action in [('textbox', f'{prefix} name', 'fill'), ('button', f'Save {prefix}', 'click')]:
                observation = command(type='browser.observe')
                target = next(item['target'] for item in observation['targets'] if item.get('name') == label and item.get('role') == role)
                arguments = {'type': 'browser.act', 'action': action, 'target': target,
                             'observationId': observation['observationId']}
                if action == 'fill':
                    arguments['value'] = name
                command(**arguments)
            command(type='browser.wait', selector='[role="status"]', text=f'Saved {prefix} {name}')
        # 范围：从其他输入框取得焦点后，定向 Tab 必须真实派发给目标并使其失焦；
        # 同时覆盖两层 Shadow DOM、同源 iframe、过期观察拒绝与全局按键，不代表生产校验提示触发成功。
        for prefix, other in [('Plain', 'Shadow'), ('Shadow', 'Plain'), ('Frame', 'Plain')]:
            observation = command(type='browser.observe')
            other_target = next(t['target'] for t in observation['targets'] if t.get('name') == f'{other} name')
            command(type='browser.act', action='click', target=other_target, observationId=observation['observationId'])
            observation = command(type='browser.observe')
            assert observation['viewport']['targetedPress'] is True
            target = next(t['target'] for t in observation['targets'] if t.get('name') == f'{prefix} name')
            # 当前观察身份不能让虚构目标获得全局按键兜底，拒绝后原观察仍可用于有效目标。
            missing = attempt(type='browser.act', action='press', target='dom-missing', value='Tab', observationId=observation['observationId'])
            assert missing['result']['Err']['code'] == 'INVALID_TARGET', missing
            assert missing['result']['Err']['effect'] == 'NOT_STARTED', missing
            receipt = command(type='browser.act', action='press', target=target, value='Tab', observationId=observation['observationId'])
            assert receipt['keyboard'] == {'scope': 'target', 'target': target, 'focusVerified': True}, receipt
            stale = attempt(type='browser.act', action='press', target=target, value='Tab', observationId=observation['observationId'])
            assert stale['result']['Err']['code'] == 'STALE_OBSERVATION', stale
            assert stale['result']['Err']['effect'] == 'NOT_STARTED', stale
            command(type='browser.wait', selector='#keyboard', text=f'Key {prefix} Tab Blur {prefix}')
        global_press = command(type='browser.act', action='press', value='Escape')
        assert global_press['keyboard'] == {'scope': 'current-focus', 'focusVerified': False}, global_press
        # 证据采集：检查真实 PNG 和页面标题；不测试节点的上传与存储回执。
        observation = command(type='browser.observe', screenshot=True)
        screenshot = Path(observation['localScreenshot'])
        assert screenshot.read_bytes().startswith(b'\x89PNG\r\n\x1a\n')
        assert observation['title'] == 'ProofRun engine fixture', observation
        assert server.writes == [{'prefix': 'Plain', 'name': 'Ada'}, {'prefix': 'Shadow', 'name': 'Lin'}], server.writes
        # 范围：真实 focus 监听器夺走焦点时返回未确认并结束 host；不覆盖控制面资源回收。
        redirect = next(t['target'] for t in observation['targets'] if t.get('name') == 'Redirect focus')
        denied = attempt(type='browser.act', action='press', target=redirect, value='Tab', observationId=observation['observationId'])
        assert denied['result']['Err']['code'] == 'KEYBOARD_FOCUS_UNCONFIRMED', denied
        assert denied['result']['Err']['effect'] == 'MAY_HAVE_HAPPENED', denied
        # 关闭父管道以释放 Tokio 已开始的阻塞 stdin 读取，避免把运行时退出等待误判为按键失败。
        process.stdin.close()
        assert process.wait(timeout=10) == 0
        # 独立 HTTP 记录收到的键；无效目标、过期观察和焦点被抢走都不能增加 Tab 次数。
        deadline = time.monotonic() + 3
        while len(server.key_events) < 3 and time.monotonic() < deadline:
            time.sleep(.05)
        assert [event for event in server.key_events if event['key'] == 'Tab'] == [
            {'prefix': prefix, 'key': 'Tab'} for prefix in ['Plain', 'Shadow', 'Frame']
        ], server.key_events
        print(json.dumps({'passed': ['real native CLI and Chrome', 'fresh observation references',
                                     'plain and two-level open Shadow DOM forms', 'shadow condition wait',
                                     'two independently counted business writes', 'PNG screenshot',
                                     'targeted Tab focus and blur in DOM, Shadow DOM and iframe',
                                     'stale press rejection and current-focus receipt',
                                     'focus redirection stops key dispatch'],
                          'root': str(root), 'screenshot': str(screenshot)}, indent=2))
    finally:
        if process.poll() is None:
            if not process.stdin.closed:
                send({'type': 'close'})
                process.stdin.close()
            process.wait(timeout=15)
        process.stdin.close()
        log.close()
        server.shutdown()
        server.server_close()
        # 退出清理：只检查本次 harness 的 daemon；不验证 Linux cgroup 回收。
        for pid in known_pids:
            deadline = time.monotonic() + 3
            while True:
                try:
                    os.kill(pid, 0)
                except ProcessLookupError:
                    break
                assert time.monotonic() < deadline, f'engine daemon survived close: {pid}'
                time.sleep(.05)
        shutil.rmtree(socket_dir, ignore_errors=True)
        assert process.returncode == 0, (root / 'stderr.log').read_text()


if __name__ == '__main__':
    run()
