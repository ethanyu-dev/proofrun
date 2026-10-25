#!/usr/bin/env python3
"""验证单节点对两套回环控制面的授权、共享准入与隔离。

使用真实 Rust 进程、SQLite、WebSocket 和 systemd，但 API/浏览器为夹具；
不覆盖生产 TLS、真实网页画面或完整业务 API 的模型决策。
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import queue
import socket
import sqlite3
import struct
import subprocess
import tempfile
import time
import uuid

from gateway_integration import Gateway, Handler
from systemd_integration import BINARY, FAKE, Client, assert_ok


class PairHandler(Handler):
    def do_POST(self):
        # 配对夹具核对独立码与节点身份；回执仅供本地机器凭据注册测试。
        assert self.path == '/v1/nodes/pair'
        value = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        assert value['pairingToken'] == self.server.token
        result = {'nodeId': value['nodeId'], 'pool': value['pool'], 'protocolVersion': '0.1', 'token': self.server.token}
        body = json.dumps(result).encode()
        self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class Peer(Client):
    """只包装一个网关的消息队列；不启动第二个 Node 进程。"""
    def __init__(self, root, gateway):
        self.root, self.gateway = root, gateway
        self.queue, self.pending = gateway.messages, {}
        self.heartbeat = self.next(lambda m: m.get('type') == 'node.heartbeat')

    def send(self, command):
        self.gateway.send(command)


class Direct:
    """最小真实客户端帧实现，避免依赖 Python WebSocket 第三方包。"""
    def __init__(self, port, node_id, token, origin='http://localhost:5173'):
        self.socket = socket.create_connection(('127.0.0.1', port), timeout=5)
        self.reader = self.socket.makefile('rb')
        key = base64.b64encode(os.urandom(16)).decode()
        self.socket.sendall(f'GET /hitl/control HTTP/1.1\r\nHost: localhost:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: {key}\r\nOrigin: {origin}\r\n\r\n'.encode())
        assert b'101' in self.reader.readline()
        while self.reader.readline() != b'\r\n':
            pass
        self.send({'type': 'authenticate', 'nodeId': node_id, 'id': 'same-intervention', 'token': token})

    def send(self, value):
        data = json.dumps(value).encode()
        mask = os.urandom(4)
        head = bytes([0x81, 0x80 | len(data)]) if len(data) < 126 else bytes([0x81, 0xfe]) + struct.pack('!H', len(data))
        self.socket.sendall(head + mask + bytes(x ^ mask[i % 4] for i, x in enumerate(data)))

    def receive(self):
        head = self.reader.read(2)
        assert len(head) == 2, 'direct socket closed before expected response'
        length = head[1] & 127
        if length == 126:
            length = struct.unpack('!H', self.reader.read(2))[0]
        assert length < 65536
        return json.loads(self.reader.read(length))

    def close(self):
        self.reader.close()
        self.socket.close()


def run():
    with tempfile.TemporaryDirectory(prefix='proofrun-multi-') as directory:
        root = Path(directory)
        gateways = [Gateway(PairHandler), Gateway(PairHandler)]
        for i, gateway in enumerate(gateways):
            gateway.token = str(i) * 40
            gateway.gateway_path = '/v1/nodes/connect'
            gateway.fail_first_upload = False
        probe = socket.socket(); probe.bind(('127.0.0.1', 0)); port = probe.getsockname()[1]; probe.close()
        config = root / 'node.toml'
        state = root / 'state'
        config.write_text(f'home = {json.dumps(str(state))}\nagent_browser_bin = {json.dumps(str(FAKE))}\n'
                          f'listen = "127.0.0.1:{port}"\npublic_url = "http://127.0.0.1:{port}"\n'
                          'memory_reserve_bytes = 67108864\nsession_reserve_bytes = 67108864\nmax_lease_ms = 120000\nallow_unverified_writes = true\n')
        def cli(*args, success=True):
            result = subprocess.run([str(BINARY), '--config', str(config), 'bindings', *args], capture_output=True, text=True, timeout=20)
            assert (result.returncode == 0) == success, result.stderr
            return json.loads(result.stdout) if success else result.stderr
        log = (root / 'stderr.log').open('a')
        process = subprocess.Popen([str(BINARY), '--config', str(config), 'serve'], stderr=log)
        connections = []
        try:
            # 热添加两个独立控制面，所有运行与资源状态属于同一个 Node 进程。
            time.sleep(1)
            for name, gateway in zip(['prod', 'dev'], gateways):
                token = root / (name + '-pairing'); token.write_text(gateway.token)
                cli('add', '--name', name, '--api', f'http://127.0.0.1:{gateway.server_port}', '--pool', name,
                    '--console-origin', 'http://localhost:5173', '--pairing-token-file', str(token))
            peers = [Peer(root, gateway) for gateway in gateways]
            assert peers[0].heartbeat['nodeId'] != peers[1].heartbeat['nodeId']
            for peer in peers:
                while not peer.heartbeat['admission']['accepting']:
                    peer.fresh_heartbeat()
            # 同时请求相同会话/命令 ID；全局创建锁只允许一个通过启动稳定期。
            commands = []
            for peer in peers:
                request = peer.request('same-session', 'session.open', leaseRequestId=peer.heartbeat['leaseRequestId'], leaseTtlMs=120000, maxDurationMs=120000)
                request['commandId'] = 'same-open'
                commands.append(request); peer.send(request)
            results = [p.result(c) for p, c in zip(peers, commands)]
            assert sorted(r['operationStatus'] for r in results) == ['FAILED', 'SUCCEEDED'], results
            rejected = next(i for i, r in enumerate(results) if r['operationStatus'] == 'FAILED')
            assert results[rejected]['error']['code'] == 'RESOURCE_UNAVAILABLE', results
            assert results[rejected]['effect'] == 'NOT_STARTED', results
            assert_ok(peers[rejected].open('same-session', ttl=120000))
            for peer in peers:
                peer.fresh_heartbeat()
                assert len(peer.heartbeat['occupied']) == 1, peer.heartbeat
            # 不同绑定内相同命令 ID 各自去重；证据只上传到所属控制面。
            artifact_ids = []
            for peer in peers:
                command = peer.request('same-session', 'browser.observe', screenshot=True); command['commandId'] = 'same-observe'
                peer.send(command); result = peer.result(command); assert_ok(result)
                artifact_ids.append(result['data']['artifactRefs'][0]['artifactId'])
            for i, peer in enumerate(peers):
                available = peer.next(lambda x: x.get('type') == 'artifact.available', timeout=25)
                assert available['artifactId'] == artifact_ids[i]
                assert artifact_ids[1-i] not in peer.gateway.uploads
            peers[0].send({'type': 'ack', 'messageId': 'same-observe'})
            time.sleep(.2)
            with sqlite3.connect(state / 'node.db') as db:
                remaining = db.execute('SELECT binding FROM outbox WHERE id=?', ['same-observe']).fetchall()
                assert remaining == [(peers[1].heartbeat['nodeId'],)], remaining
            # 单侧网络断开独立重连，另一侧仍可观察；不是生产网络故障演练。
            original_epoch = peers[0].heartbeat['nodeEpoch']
            gateways[0].connection.shutdown(socket.SHUT_RDWR)
            gateways[0].connection.close()
            assert_ok(peers[1].call('same-session', 'browser.observe'))
            peers[0].fresh_heartbeat()
            assert peers[0].heartbeat['nodeEpoch'] == original_epoch
            assert gateways[0].authorized_connections >= 2
            foreign = peers[1].request('same-session', 'browser.observe')
            foreign['nodeId'] = peers[0].heartbeat['nodeId']
            peers[1].send(foreign)
            assert peers[1].result(foreign)['error']['code'] == 'STALE_NODE'
            # 控制面不能扩大本地批准的来源；相同介入 ID 的直连按 nodeId 路由。
            tokens = ['a' * 40, 'b' * 40]
            for i, peer in enumerate(peers):
                grant = {'id': 'same-intervention', 'tokenHash': hashlib.sha256(tokens[i].encode()).hexdigest(),
                         'connectExpiresAt': int(time.time()*1000)+60000, 'expiresAt': int(time.time()*1000)+60000,
                         'origin': 'http://localhost:5173', 'authRevision': 0,
                         'state': {'type': 'state', 'mode': 'HUMAN', 'targetUrl': 'https://target.test', 'items': []}}
                wrong = {**grant, 'origin': 'https://unapproved.test'}
                denied = peer.call('same-session', 'session.control', revision=1, mode='HUMAN', grant=wrong)
                assert denied['error']['code'] == 'ORIGIN_NOT_ALLOWED', denied
                assert_ok(peer.call('same-session', 'session.control', revision=1, mode='HUMAN', grant=grant))
            cross = Direct(port, peers[1].heartbeat['nodeId'], tokens[0]); connections.append(cross)
            assert cross.receive()['code'] == 'HITL_INVALID'
            for i, peer in enumerate(peers):
                direct = Direct(port, peer.heartbeat['nodeId'], tokens[i]); connections.append(direct)
                assert direct.receive()['type'] == 'state'
            # 排空只影响新会话，撤销同时使存量直连失效，不切断另一套服务。
            cli('drain', 'prod')
            peers[0].fresh_heartbeat()
            assert peers[0].heartbeat['admission']['reason'] == 'BINDING_DRAINING'
            cli('revoke', 'prod')
            assert connections[-2].receive()['type'] == 'error'
            cli('resume', 'prod', success=False)
            connections[-1].send({'type': 'complete', 'confirmedItems': []})
            completed = peers[1].next(lambda x: x.get('type') == 'hitl.finished')
            assert completed['nodeId'] == peers[1].heartbeat['nodeId']
            assert_ok(peers[1].call('same-session', 'session.close'))
            deadline = time.monotonic()+20
            while any(b['remainingSessions'] for b in cli('list')['bindings']):
                assert time.monotonic() < deadline
                time.sleep(.2)
            # 重启后撤销墓碑仍生效，未确认结果只重送给原控制面。
            prod_connections = gateways[0].authorized_connections
            process.terminate(); process.wait(timeout=25); assert process.returncode == 0
            process = subprocess.Popen([str(BINARY), '--config', str(config), 'serve'], stderr=log)
            peers[1].fresh_heartbeat()
            time.sleep(1)
            assert gateways[0].authorized_connections == prod_connections
            assert cli('list')['bindings'][1]['state'] == 'REVOKED'
            print('multi-binding: hot pairing, shared admission, scoped sessions/ACK/artifacts, origin grants, direct routing, drain/revoke and restart passed')
        finally:
            for connection in connections:
                connection.close()
            process.terminate()
            process.wait(timeout=30)
            log.close()
            for gateway in gateways:
                gateway.shutdown(); gateway.server_close()
            assert process.returncode == 0, (root / 'stderr.log').read_text()


if __name__ == '__main__':
    run()
