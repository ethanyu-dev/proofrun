#!/usr/bin/env python3
"""真实原生 CLI/Chrome 的临时身份隔离与网络元数据验证。
不经过控制面、Linux systemd 或真实业务登录，不证明服务端写入 exactly-once。
"""
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import tempfile
import threading
import uuid


class Page(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        login = self.path.startswith('/login')
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        if login:
            self.send_header('Set-Cookie', 'proofrun_auth=fixture-secret; Path=/; SameSite=Lax')
        self.end_headers()
        script = "localStorage.setItem('account','fixture-secret');" if login else ''
        if 'revision=updated' in self.path:
            script += "localStorage.setItem('revision','updated');"
        self.wfile.write(('''<title>Authentication fixture</title><p id="result"></p><script>''' + script + '''document.querySelector('#result').textContent = document.cookie.includes('proofrun_auth=fixture-secret') && localStorage.getItem('account') === 'fixture-secret' ? 'Authenticated' : 'Login required';</script>''').encode())


@contextmanager
def host(root, seed=None, external_account=None):
    """每次使用独立 profile 与 daemon，验证临时目录隔离，不接受历史基准。"""
    session = uuid.uuid4().hex
    directory = root / session
    directory.mkdir()
    stderr = (directory / 'stderr.log').open('w')
    process = subprocess.Popen([str(Path(os.environ.get('PROOFRUN_TEST_BINARY', 'target/debug/proofrun-node')).resolve()), 'session-host', '--directory', str(directory)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr, text=True, bufsize=1)
    messages = queue.Queue()
    def reader():
        for line in process.stdout:
            messages.put(json.loads(line))
        messages.put(None)
    threading.Thread(target=reader, daemon=True).start()
    def receive():
        value = messages.get(timeout=30)
        assert value is not None, (directory / 'stderr.log').read_text()
        return value
    def send(value):
        process.stdin.write(json.dumps(value) + '\n')
        process.stdin.flush()
    def raw_command(**operation):
        send({'type': 'run', 'command': operation, 'timeout_ms': 15000})
        message = receive()
        return message['result']
    def command(**operation):
        result = raw_command(**operation)
        assert 'Ok' in result, result
        return result['Ok']
    command.raw = raw_command
    try:
        assert receive()['type'] == 'host.ready'
        boot_ms = int(float(Path('/proc/uptime').read_text().split()[0]) * 1000) if Path('/proc/uptime').exists() else 0
        send({'type': 'init', 'config': {'binary': os.environ['PROOFRUN_AGENT_BROWSER_BIN'], 'chrome': os.environ['PROOFRUN_CHROME_BIN'], 'session': session, 'directory': str(directory), 'allow_unverified_writes': True, 'external_account': external_account, 'network_evidence': True, 'identity_seed_file': str(seed) if seed else None}, 'deadline_ms': boot_ms + 120000, 'startup_deadline_ms': boot_ms + 120000})
        message = receive()
        assert 'Ok' in message['result'], message
        command.opened = message['result']['Ok']
        yield command
    finally:
        if process.poll() is None:
            send({'type': 'close'})
            process.wait(timeout=15)
        process.stdin.close()
        stderr.close()
        shutil.rmtree(Path('/tmp') / f'proofrun-{os.getuid()}' / session, ignore_errors=True)
        assert process.returncode == 0


def run():
    root = Path(tempfile.mkdtemp(prefix='proofrun-auth-network-'))
    state = root / 'auth' / 'account.json'
    server = ThreadingHTTPServer(('127.0.0.1', 0), Page)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{server.server_port}'
    try:
        # 范围：当前会话保留 Cookie/localStorage，网络元数据脱敏；不证明真实业务认证。
        with host(root) as command:
            command(type='browser.act', action='navigate', target=base + '/login?token=fixture-secret')
            first = command(type='browser.observe')
            assert 'Authenticated' in first['text'], first
            network = first['network']
            assert any(row['url'] == base + '/login' and row['status'] == 200 for row in network['requests']), network
            assert 'fixture-secret' not in json.dumps(network)
            assert command.raw(type='browser.auth.save')['Err']['code'] == 'AUTH_SAVE_RETIRED'
            command(type='browser.act', action='navigate', target=base + '/verify')
            assert 'Authenticated' in command(type='browser.observe')['text']
        # 范围：下一次独立会话无旧 Cookie/localStorage，不发布任何基准文件。
        with host(root) as command:
            command(type='browser.act', action='navigate', target=base + '/verify')
            assert 'Login required' in command(type='browser.observe')['text']
        assert not state.exists()
        print('ephemeral identity: current-session state, no profile save, next-session isolation and network redaction passed')
    finally:
        server.shutdown()
        server.server_close()
        shutil.rmtree(root)


if __name__ == '__main__':
    run()
