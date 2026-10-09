#!/usr/bin/env python3
"""验证 Linux systemd/cgroup 下的会话容量、故障恢复和进程清理。

测试使用故意脱离 CLI 并忽略 SIGTERM 的假引擎；不验证真实 Chrome 的页面行为。
"""
import json
import os
from pathlib import Path
import queue
import signal
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import uuid

BINARY = Path(os.environ.get('PROOFRUN_TEST_BINARY', '/target/debug/proofrun-node'))
FAKE = Path(__file__).with_name('fake_engine.py').resolve()

class Client:
    def __init__(self, root):
        self.root = Path(root)
        self.config = self.root / 'node.toml'
        self.config.write_text(f'home = {json.dumps(str(self.root / "state"))}\nagent_browser_bin = {json.dumps(str(FAKE))}\ncapacity = 2\nallow_unverified_writes = true\n')
        self.start()

    def start(self):
        self.queue = queue.Queue()
        self.pending = {}
        self.log = (self.root / 'stderr.log').open('a')
        self.process = subprocess.Popen([str(BINARY), '--config', str(self.config), 'serve', '--stdio'],
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.log, text=True, bufsize=1)
        process, messages = self.process, self.queue
        def read():
            for line in process.stdout:
                messages.put(json.loads(line))
            messages.put(None)
        threading.Thread(target=read, daemon=True).start()
        self.heartbeat = self.next(lambda x: x.get('type') == 'node.heartbeat')

    def next(self, predicate, timeout=25):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            message = self.queue.get(timeout=max(.01, deadline - time.monotonic()))
            if message is None:
                raise RuntimeError((self.root / 'stderr.log').read_text())
            with (self.root / 'events.jsonl').open('a') as events:
                events.write(json.dumps(message) + '\n')
            if message.get('type') == 'node.heartbeat':
                self.heartbeat = message
            if predicate(message):
                return message
            if 'commandId' in message:
                self.pending[message['commandId']] = message
        raise TimeoutError('node response timed out')

    def request(self, session, operation, timeout_ms=15000, **extra):
        return {'protocolVersion': '0.1', 'commandId': uuid.uuid4().hex, 'nodeId': self.heartbeat['nodeId'],
                'nodeEpoch': self.heartbeat['nodeEpoch'], 'sessionId': session, 'leaseId': 'lease-' + session,
                'fence': 1, 'timeoutMs': timeout_ms, 'command': {'type': operation, **extra}}

    def send(self, command):
        self.process.stdin.write(json.dumps(command) + '\n')
        self.process.stdin.flush()

    def result(self, command):
        identity = command['commandId']
        if identity in self.pending:
            return self.pending.pop(identity)
        return self.next(lambda x: x.get('commandId') == identity and x.get('type') == 'command.result')

    def call(self, session, operation, **extra):
        command = self.request(session, operation, **extra)
        self.send(command)
        return self.result(command)

    def open(self, session, ttl=60000, max_ms=120000, renewable=False):
        options = {'renewable': True, 'liveView': True} if renewable else {}
        return self.call(session, 'session.open', leaseRequestId=self.heartbeat['leaseRequestId'], leaseTtlMs=ttl, maxDurationMs=max_ms, **options)

    def fresh_heartbeat(self):
        # cgroup 核查耗时可能让旧心跳滞留在测试读取队列中。
        while True:
            try:
                message = self.queue.get_nowait()
            except queue.Empty:
                break
            assert message is not None
            if 'commandId' in message:
                self.pending[message['commandId']] = message
        return self.next(lambda x: x.get('type') == 'node.heartbeat')

    def record(self, session):
        with sqlite3.connect(self.root / 'state/node.db') as db:
            return json.loads(db.execute('SELECT record FROM sessions WHERE id=?', [session]).fetchone()[0])

    def directory(self, session):
        return self.root / 'state/sessions' / self.record(session)['launch_id']

    def pids(self, session):
        deadline = time.monotonic() + 3
        while not (self.directory(session) / 'grandchild.pid').exists():
            assert time.monotonic() < deadline, 'fixture descendant did not start'
            time.sleep(.02)
        return [int((self.directory(session) / name).read_text()) for name in ['daemon.pid', 'grandchild.pid']]

    def stop(self):
        if self.process.poll() is None:
            self.process.stdin.close()
            self.process.wait(timeout=25)
        self.log.close()


def assert_ok(result):
    assert result.get('operationStatus') == 'SUCCEEDED', result


def wait_gone(pids):
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        if all(not Path(f'/proc/{pid}').exists() for pid in pids):
            return
        time.sleep(.1)
    raise AssertionError(f'processes survived: {pids}')


def run():
    """按独立故障场景运行节点；各段注释限定该场景的验证范围。"""
    root = tempfile.mkdtemp(prefix='proofrun-systemd-')
    client = Client(root)
    checks = []
    try:
        # 容量准入：两个会话占满配置上限，第三个立即拒绝；不验证全局调度队列。
        assert_ok(client.open('one')); assert_ok(client.open('two'))
        pids_one, pids_two = client.pids('one'), client.pids('two')
        rejected = client.open('third')
        assert rejected['error']['code'] == 'NODE_BUSY', rejected
        checks.append('capacity admission')

        # 观察与证据：假引擎截图进入本地 spool 并保持 PENDING；不验证远端存储。
        observation = client.call('one', 'browser.observe', screenshot=True)
        assert_ok(observation)
        assert observation['data']['artifactRefs'][0]['status'] == 'PENDING'
        checks.append('artifact spool and observation')

        # 去重与引用：同 ID 不重复写、变更 payload 被拒绝，动作后旧观察失效。
        # 写入计数来自假引擎文件，不代表真实业务服务的提交次数。
        action = client.request('one', 'browser.act', action='click', target='element-1',
                                observationId=observation['data']['observationId'])
        client.send(action); first = client.result(action); assert_ok(first)
        client.send(action); assert client.result(action) == first
        assert (client.directory('one') / 'writes').read_text() == '1'
        stale = dict(action, commandId=uuid.uuid4().hex)
        client.send(stale)
        assert client.result(stale)['error']['code'] == 'STALE_OBSERVATION'
        conflict = dict(action, command={**action['command'], 'target': '#other'})
        client.send(conflict); assert client.result(conflict)['error']['code'] == 'COMMAND_CONFLICT'
        checks.append('durable command deduplication')
        checks.append('action invalidates observation targets')

        # 会话隔离：等待时拒绝并发操作；关闭中断等待并回收本会话后代。
        # 另一个会话的后代仍存活，验证的是 systemd 范围而非页面状态。
        wait = client.request('one', 'browser.wait', selector='#never', text='ready', timeout_ms=30000)
        client.send(wait)
        time.sleep(.2)
        busy = client.call('one', 'browser.observe')
        assert busy['error']['code'] == 'SESSION_BUSY', busy
        started = time.monotonic(); assert_ok(client.call('one', 'session.close'))
        assert time.monotonic() - started < 10
        wait_gone(pids_one)
        assert all(Path(f'/proc/{pid}').exists() for pid in pids_two)
        checks.append('cancel interrupts wait and closes descendant cgroup only')

        # 身份栅栏：错误 fence 与旧 nodeEpoch 均不能操作现有会话。
        # 不覆盖正式控制面的节点选择与租约签发。
        wrong = client.request('two', 'browser.observe'); wrong['fence'] = 99
        client.send(wrong); assert client.result(wrong)['error']['code'] == 'STALE_LEASE'
        wrong = client.request('two', 'browser.observe'); wrong['nodeEpoch'] = 'old'
        client.send(wrong); assert client.result(wrong)['error']['code'] == 'STALE_NODE'
        checks.append('lease and node incarnation fencing')

        # 未知写入：假引擎先记一次写再延迟响应，超时结果标记 MAY_HAVE_HAPPENED。
        # 重送同 ID 不再执行；不覆盖 agent-browser 内部可能发生的重试。
        observed = client.call('two', 'browser.observe'); assert_ok(observed)
        uncertain = client.request('two', 'browser.act', action='click', target='element-2', timeout_ms=500,
                                   observationId=observed['data']['observationId'])
        client.send(uncertain); result = client.result(uncertain)
        assert result['effect'] == 'MAY_HAVE_HAPPENED', result
        client.send(uncertain); assert client.result(uncertain) == result
        wait_gone(pids_two)
        assert (client.directory('two') / 'writes').read_text() == '1'
        checks.append('unknown write is never replayed')

        # 范围：普通会话保留总时限；人工可续期会话跨过初始时限，仍在短租约到期时清理。引擎为故障夹具。
        assert client.heartbeat['capabilities']['renewableSessions'] is True
        client.fresh_heartbeat()
        assert_ok(client.open('fixed-time', max_ms=1000))
        wait_gone(client.pids('fixed-time'))
        client.fresh_heartbeat()
        assert_ok(client.open('human-time', ttl=3000, max_ms=1000, renewable=True))
        human_pids = client.pids('human-time')
        runtime = subprocess.check_output(['systemctl', '--user', 'show', client.record('human-time')['unit'], '-p', 'RuntimeMaxUSec', '--value'], text=True).strip()
        assert runtime == 'infinity', runtime
        assert_ok(client.call('human-time', 'session.renew', leaseRequestId=client.heartbeat['leaseRequestId'], leaseTtlMs=5000))
        time.sleep(1.5)
        assert_ok(client.call('human-time', 'browser.observe'))
        wait_gone(human_pids)
        late = client.call('human-time', 'session.renew', leaseRequestId=client.heartbeat['leaseRequestId'], leaseTtlMs=60000)
        assert late['operationStatus'] != 'SUCCEEDED', late
        checks.append('renewable HITL session crosses initial duration but expires with lease')

        # 续租控制路径：长等待期间续租绕过浏览器操作许可，关闭仍可取消等待。
        # 这里通过本地管道送命令，不覆盖网络延迟或断线后的续租。
        client.fresh_heartbeat()
        assert_ok(client.open('renew', ttl=2000))
        renewing = client.request('renew', 'browser.wait', selector='#never', text='ready', timeout_ms=15000)
        client.send(renewing)
        time.sleep(.1)
        assert_ok(client.call('renew', 'session.renew', leaseRequestId=client.heartbeat['leaseRequestId'], leaseTtlMs=60000))
        time.sleep(2)
        assert client.call('renew', 'browser.observe')['error']['code'] == 'SESSION_BUSY'
        assert_ok(client.call('renew', 'session.close'))
        assert client.result(renewing)['operationStatus'] == 'CANCELLED'
        checks.append('renewal bypasses busy browser operation')

        # 租约到期：空闲会话的 daemon 和后代被清理，记录最终变为 CLOSED。
        # 后代由假引擎创建，不覆盖真实 Chrome 的退出行为。
        client.fresh_heartbeat()
        assert_ok(client.open('expires', ttl=1500))
        wait_gone(client.pids('expires'))
        deadline = time.monotonic() + 3
        while client.record('expires')['state'] != 'CLOSED':
            assert time.monotonic() < deadline
            time.sleep(.05)
        checks.append('lease expiry closes idle session descendants')

        # 主进程 SIGKILL：新 epoch 启动后关闭旧进程范围，未提交命令恢复为 UNKNOWN。
        # 不模拟主机重启或 SQLite 损坏。
        assert_ok(client.open('restart', renewable=True))
        restart_pids = client.pids('restart')
        old_epoch = client.heartbeat['nodeEpoch']
        interrupted = client.request('restart', 'browser.wait', selector='#never', text='ready', timeout_ms=30000)
        client.send(interrupted); time.sleep(.2)
        client.process.kill(); client.process.wait(timeout=5); client.log.close()
        client.start()
        assert client.heartbeat['nodeEpoch'] != old_epoch
        wait_gone(restart_pids)
        assert client.record('restart')['state'] == 'CLOSED'
        with sqlite3.connect(client.root / 'state/node.db') as db:
            recovered = json.loads(db.execute('SELECT result FROM commands WHERE id=?', [interrupted['commandId']]).fetchone()[0])
        assert recovered['operationStatus'] == 'UNKNOWN', recovered
        checks.append('SIGKILL restart recovery without action replay')

        # 晚到授权：TTL 从心跳发出时计时，延迟送达的短租约会被拒绝。
        # 延迟由本地等待模拟，不覆盖真实广域网络的时钟与传输故障。
        time.sleep(.3)
        expired = client.open('expired', ttl=1)
        assert expired['error']['code'] == 'LEASE_EXPIRED', expired
        checks.append('late lease grant rejection')
        print(json.dumps({'passed': checks, 'root': root}, indent=2))
    finally:
        client.stop()
        active = subprocess.check_output(['systemctl', '--user', 'list-units', '--state=active,activating,deactivating', '--plain', '--no-legend',
                                          f'proofrun-{client.heartbeat["nodeId"]}-*.service'], text=True)
        assert not active.strip(), active

if __name__ == '__main__':
    run()
