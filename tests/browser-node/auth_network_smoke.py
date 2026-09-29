#!/usr/bin/env python3
"""真实原生 CLI/Chrome 的登录存储复用与网络元数据验证。
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
def host(root, state, restore, snapshot_id=None, optional=False):
    """每次使用独立 profile 与 daemon，验证共享的仅为存储状态。"""
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
    def command(**operation):
        send({'type': 'run', 'command': operation, 'timeout_ms': 15000})
        message = receive()
        assert 'Ok' in message['result'], message
        return message['result']['Ok']
    try:
        assert receive()['type'] == 'host.ready'
        boot_ms = int(float(Path('/proc/uptime').read_text().split()[0]) * 1000) if Path('/proc/uptime').exists() else 0
        send({'type': 'init', 'config': {'binary': os.environ['PROOFRUN_AGENT_BROWSER_BIN'], 'chrome': os.environ['PROOFRUN_CHROME_BIN'], 'session': session, 'directory': str(directory), 'allow_unverified_writes': True, 'auth_state': str(state), 'restore_auth': restore, 'restore_auth_if_present': optional, 'auth_snapshot_id': snapshot_id, 'network_evidence': True}, 'deadline_ms': boot_ms + 120000})
        message = receive()
        assert 'Ok' in message['result'], message
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
        # 范围：首次会话的 Cookie/localStorage 保存、网络记录脱敏；不是真实认证系统。
        with host(root, state, False) as command:
            command(type='browser.act', action='navigate', target=base + '/login?token=fixture-secret')
            first = command(type='browser.observe')
            assert 'Authenticated' in first['text'], first
            network = first['network']
            assert any(row['url'] == base + '/login' and row['status'] == 200 for row in network['requests']), network
            assert 'fixture-secret' not in json.dumps(network)
            assert command(type='browser.auth.save')['saved']
            assert state.stat().st_mode & 0o077 == 0
        # 范围：第二个独立 profile 载入状态后保留 Cookie 和 localStorage，不复用旧 daemon。
        with host(root, state, True) as command:
            command(type='browser.act', action='navigate', target=base + '/verify')
            second = command(type='browser.observe')
            assert 'Authenticated' in second['text'], second
        # 范围：同轮两组从同一快照恢复到独立浏览器；后保存的旧版本不会覆盖先保存的新状态。
        with host(root, state, True, 'pair') as first, host(root, state, True, 'pair') as second:
            for command in [first, second]:
                command(type='browser.act', action='navigate', target=base + '/verify')
                assert 'Authenticated' in command(type='browser.observe')['text']
            # 修改本地夹具的存储版本，不使用真实登录凭据。
            first(type='browser.act', action='navigate', target=base + '/login?revision=updated')
            assert first(type='browser.auth.save')['saved']
            preserved = state.read_bytes()
            result = second(type='browser.auth.save')
            assert result == {'saved': False, 'reason': 'NEWER_STATE_PRESERVED'}, result
            assert state.read_bytes() == preserved
        # 范围：首次缺失快照时允许进入登录页，即使另一组已保存，同轮后启动组仍为空状态。
        fresh = root / 'auth' / 'fresh.json'
        with host(root, fresh, True, 'fresh-pair', True) as first:
            first(type='browser.act', action='navigate', target=base + '/verify')
            assert 'Login required' in first(type='browser.observe')['text']
            first(type='browser.act', action='navigate', target=base + '/login')
            assert first(type='browser.auth.save')['saved']
        with host(root, fresh, True, 'fresh-pair', True) as second:
            second(type='browser.act', action='navigate', target=base + '/verify')
            assert 'Login required' in second(type='browser.observe')['text']
        with host(root, fresh, True, 'next-pair', True) as next_run:
            next_run(type='browser.act', action='navigate', target=base + '/verify')
            assert 'Authenticated' in next_run(type='browser.observe')['text']
        print(json.dumps({'passed': ['real cookie and localStorage save/restore', 'isolated browser profiles', 'real network status and URL redaction', 'private state permissions', 'parallel immutable snapshots and compare-before-save', 'first login and automatic next-run restore'], 'realModel': False, 'productionVM': False}, indent=2))
    finally:
        server.shutdown()
        server.server_close()
        shutil.rmtree(root)


if __name__ == '__main__':
    run()
