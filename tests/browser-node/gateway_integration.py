#!/usr/bin/env python3
"""验证节点与回环控制面之间的 WebSocket 重连、ACK 和截图交付。

使用真实 WebSocket 帧与 HTTP 回执，但控制面和存储均为本地夹具；不覆盖
生产 TLS、凭据轮换或正式控制面数据库。
"""
import base64
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import queue
import socket
import sqlite3
import struct
import subprocess
import tempfile
import threading
import time

from systemd_integration import BINARY, FAKE, Client, assert_ok


class Gateway(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self):
        super().__init__(('127.0.0.1', 0), Handler)
        self.messages = queue.Queue()
        self.connection = None
        self.send_lock = threading.Lock()
        self.uploads = {}
        self.fail_first_upload = True
        self.upload_attempts = 0
        self.authorized_connections = 0
        threading.Thread(target=self.serve_forever, daemon=True).start()

    def send(self, value, opcode=1):
        data = json.dumps(value).encode() if opcode == 1 else value
        length = len(data)
        header = bytes([0x80 | opcode])
        header += bytes([length]) if length < 126 else bytes([126]) + struct.pack('!H', length)
        with self.send_lock:
            self.connection.sendall(header + data)


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *_):
        pass

    def do_GET(self):
        assert self.headers['Authorization'] == 'Bearer fixture-token'
        assert self.path == '/nodes/connect'
        key = self.headers['Sec-WebSocket-Key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
        self.send_response(101)
        self.send_header('Upgrade', 'websocket')
        self.send_header('Connection', 'Upgrade')
        self.send_header('Sec-WebSocket-Accept', base64.b64encode(hashlib.sha1(key.encode()).digest()).decode())
        self.end_headers()
        self.server.connection = self.connection
        self.server.authorized_connections += 1
        try:
            while True:
                head = self.rfile.read(2)
                if len(head) != 2:
                    break
                opcode, size = head[0] & 15, head[1] & 127
                assert head[1] & 128, 'client frames must be masked'
                if size == 126:
                    size = struct.unpack('!H', self.rfile.read(2))[0]
                elif size == 127:
                    size = struct.unpack('!Q', self.rfile.read(8))[0]
                assert size <= 2 * 1024 * 1024
                mask = self.rfile.read(4)
                data = bytes(byte ^ mask[i % 4] for i, byte in enumerate(self.rfile.read(size)))
                if opcode == 8:
                    break
                if opcode == 1:
                    value = json.loads(data)
                    self.server.messages.put(value)
                    if value['type'] == 'node.heartbeat':
                        # 保持连接活跃，但不确认任何终态结果。
                        self.server.send({'type': 'ack', 'messageId': 'heartbeat-only'})
        except (ConnectionError, OSError):
            pass
        self.close_connection = True

    def do_PUT(self):
        assert self.headers['Authorization'] == 'Bearer fixture-token'
        size = int(self.headers['Content-Length'])
        assert 0 < size <= 8 * 1024 * 1024
        data = self.rfile.read(size)
        digest = hashlib.sha256(data).hexdigest()
        assert digest == self.headers['X-Content-Sha256']
        artifact = self.path.rsplit('/', 1)[-1]
        self.server.upload_attempts += 1
        if self.server.fail_first_upload:
            self.server.fail_first_upload = False
            body, status = b'{}', 503
        else:
            self.server.uploads[artifact] = data
            body = json.dumps({'artifactId': artifact, 'sha256': digest, 'stored': True}).encode()
            status = 200
        self.send_response(status)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(body)


class NetworkClient(Client):
    def __init__(self, root, gateway):
        self.root, self.gateway = Path(root), gateway
        state = self.root / 'state'
        state.mkdir()
        (state / 'credential.json').write_text('{"token":"fixture-token"}')
        port = gateway.server_port
        self.config = self.root / 'node.toml'
        self.config.write_text(f'home = {json.dumps(str(state))}\nagent_browser_bin = {json.dumps(str(FAKE))}\n'
                               f'gateway_url = "ws://127.0.0.1:{port}/nodes/connect"\n'
                               f'artifact_upload_url = "http://127.0.0.1:{port}/artifacts"\n'
                               'allow_unverified_writes = true\n')
        self.queue, self.pending = gateway.messages, {}
        self.log = (self.root / 'stderr.log').open('a')
        self.process = subprocess.Popen([str(BINARY), '--config', str(self.config), 'serve'], stderr=self.log)
        self.heartbeat = self.next(lambda x: x['type'] == 'node.heartbeat')

    def send(self, command):
        self.gateway.send(command)

    def stop(self):
        self.process.terminate()
        self.process.wait(timeout=25)
        assert self.process.returncode == 0, (self.root / 'stderr.log').read_text()
        self.log.close()


def run():
    """逐段验证网络交付路径；浏览器动作由假引擎提供。"""
    root = tempfile.mkdtemp(prefix='proofrun-gateway-')
    gateway = Gateway()
    client = None
    try:
        # 连接与观察：检查 Bearer 认证后节点能通过网关执行命令并产出待上传截图。
        # 截图内容来自假引擎，不验证真实页面图像。
        client = NetworkClient(root, gateway)
        assert_ok(client.open('remote'))
        observe = client.request('remote', 'browser.observe', screenshot=True)
        client.send(observe)
        result = client.result(observe)
        assert_ok(result)
        artifact = result['data']['artifactRefs'][0]['artifactId']
        spool = Path(root) / 'state/artifacts' / artifact
        assert spool.is_file()

        # 断线重送：结果已提交但尚未 ACK 时断开连接，重连后返回同一结果和 epoch。
        # 这里只验证节点 outbox，不验证正式控制面对重复消息的去重事务。
        gateway.connection.shutdown(socket.SHUT_RDWR)
        gateway.connection.close()
        replayed = client.next(lambda x: x.get('commandId') == observe['commandId'], timeout=15)
        assert replayed == result
        assert gateway.authorized_connections >= 2
        assert client.heartbeat['nodeEpoch'] == result['nodeEpoch']
        client.send({'type': 'ack', 'messageId': result['messageId']})

        # 存储确认：首次 HTTP 503 后重试；核对 hash 回执才标记可用并删除 spool。
        # 本地夹具回执不等同于对象存储持久性验证。
        available = client.next(lambda x: x['type'] == 'artifact.available', timeout=30)
        assert available['artifactId'] == artifact
        assert gateway.upload_attempts == 2, gateway.upload_attempts
        assert hashlib.sha256(gateway.uploads[artifact]).hexdigest() == available['sha256']
        assert not spool.exists(), 'reclaim only after durable receipt'
        with sqlite3.connect(Path(root) / 'state/node.db') as db:
            assert db.execute('SELECT count(*) FROM outbox WHERE id=?', [result['messageId']]).fetchone()[0] == 0
            assert db.execute('SELECT available FROM artifacts WHERE id=?', [artifact]).fetchone()[0] == 1
        # 关闭事件：节点确认本会话 cgroup 已关闭，并通过网关交付可重送事件。
        # 这里不验证正式控制面收到事件后如何更新全局任务状态。
        assert_ok(client.call('remote', 'session.close'))
        closed = client.next(lambda x: x['type'] == 'session.closed', timeout=10)
        assert closed['closureVerified'] is True and closed['state'] == 'CLOSED', closed
        print(json.dumps({'passed': ['authenticated outgoing WebSocket', 'reconnect and durable result resend',
                                     'ACK removes delivery entry', 'HTTP failure retries upload',
                                     'verified storage receipt releases local artifact',
                                     'durable session closure event'], 'root': root}, indent=2))
    finally:
        if client:
            client.stop()
        gateway.shutdown()
        gateway.server_close()


if __name__ == '__main__':
    run()
