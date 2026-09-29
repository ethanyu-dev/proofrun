#!/usr/bin/env python3
"""真实 API、PostgreSQL、Rust Node 和 systemd 的闭环测试。

浏览器由固定假引擎替代；不验证 Chrome 页面、模型判断、生产 TLS 或真实内网。
"""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
import uuid

# 测试仅在一次性容器内使用固定回环端口和独立角色凭据。
BASE = 'http://127.0.0.1:4121'
ADMIN = 'proofrun-admin-linux-integration-only'
WORKER = 'proofrun-worker-linux-integration-only'
BINARY = Path('/target/debug/proofrun-node')
FAKE = Path('/workspace/tests/browser-node/fake_engine.py')


def api(method, path, body=None, token=ADMIN, expected=200):
    """通过真实 HTTP 调用，同时核实状态码，避免把错误响应当作成功值。"""
    headers = {'authorization': f'Bearer {token}'}
    if body is not None:
        headers['content-type'] = 'application/json'
    request = Request(BASE + path, data=json.dumps(body).encode() if body is not None else None,
                      headers=headers, method=method)
    try:
        response = urlopen(request, timeout=5)
    except HTTPError as error:
        response = error
    with response:
        data = response.read()
        assert response.status == expected, (method, path, response.status, data)
        return json.loads(data) if data else None


def until(read, accept=bool, timeout=25):
    """轮询事实变化；临时不可连接只允许出现在明确的服务重启窗口中。"""
    end = time.monotonic() + timeout
    last = None
    while time.monotonic() < end:
        try:
            last = read()
            if accept(last):
                return last
        except URLError:
            pass
        time.sleep(.1)
    raise AssertionError(f'等待状态超时，最后值：{last}')


class Harness:
    """持有本次测试独占的服务、节点、执行租约和临时磁盘。"""
    def __init__(self):
        self.root = Path(tempfile.mkdtemp(prefix='proofrun-control-plane-'))
        self.nodes = []
        self.process = None
        self.leases = {}
        self.lock = threading.Lock()
        self.stopped = threading.Event()
        self.worker = threading.Thread(target=self.renew_workers, daemon=True)
        self.worker.start()

    def start_api(self):
        """API 重启沿用数据库和证据目录，校验实际恢复路径。"""
        env = dict(os.environ, PROOFRUN_API_HOST='127.0.0.1', PROOFRUN_API_PORT='4121',
                   PROOFRUN_PUBLIC_URL=BASE, PROOFRUN_ADMIN_TOKEN=ADMIN,
                   PROOFRUN_WORKER_TOKEN=WORKER,
                   PROOFRUN_ARTIFACT_DIRECTORY=str(self.root / 'artifacts'))
        with (self.root / 'api.log').open('ab') as log:
            self.process = subprocess.Popen(['node', '/workspace/apps/api/dist/main.js'], env=env,
                                            stdout=log, stderr=log)
        until(lambda: api('GET', '/health/ready'))

    def stop_api(self):
        """等待旧 API 完全释放数据库实例锁和监听端口。"""
        self.process.terminate()
        self.process.wait(timeout=10)

    def add_node(self):
        """真实 CLI 完成一次性配对，机器密钥只落在私有凭据文件中。"""
        root = self.root / f'node-{len(self.nodes)}'
        root.mkdir()
        config = root / 'node.toml'
        config.write_text(f'home = {json.dumps(str(root / "state"))}\n'
                          f'agent_browser_bin = {json.dumps(str(FAKE))}\n'
                          f'gateway_url = "ws://127.0.0.1:4121/v1/nodes/connect"\n'
                          f'artifact_upload_url = "{BASE}/v1/artifacts"\n'
                          'pool = "internal"\ncapacity = 1\nallow_unverified_writes = true\n')
        enrollment = api('POST', '/v1/node-pairings', {'type': 'node.enroll', 'pool': 'internal', 'name': root.name})
        code = root / 'pairing-token'
        code.write_text(enrollment['pairingToken'])
        code.chmod(0o600)
        result = subprocess.check_output([str(BINARY), '--config', str(config), 'pair',
                                          '--pairing-token-file', str(code)], text=True)
        receipt = json.loads(result)
        credential = root / 'state/credential.json'
        assert credential.stat().st_mode & 0o777 == 0o600
        assert json.loads(credential.read_text())['token'] not in result
        code.unlink()
        node = {'root': root, 'config': config, 'id': receipt['nodeId']}
        self.nodes.append(node)
        self.start_node(node)
        return node

    def start_node(self, node):
        """节点主进程与其 session-host 分开，允许测试主进程突然死亡。"""
        with (node['root'] / 'node.log').open('ab') as log:
            node['process'] = subprocess.Popen([str(BINARY), '--config', str(node['config']), 'serve'],
                                                stdout=log, stderr=log)
        until(lambda: api('GET', '/v1/nodes')['nodes'],
              lambda rows: any(row['id'] == node['id'] and row['online'] for row in rows))

    def renew_workers(self):
        """测试执行器维持独立 worker 租约；结束的执行自动停止续期。"""
        while not self.stopped.wait(1):
            with self.lock:
                leases = list(self.leases.values())
            for execution in leases:
                try:
                    api('POST', f'/v1/executions/{execution["id"]}/heartbeat', token=execution['leaseToken'])
                except (URLError, AssertionError, OSError):
                    pass

    def claim(self):
        """领取后立即续租，模拟固定执行器而不引入模型。"""
        execution = api('POST', '/v1/worker/claim', {'type': 'worker.claim', 'workerId': uuid.uuid4().hex}, WORKER)['execution']
        if execution:
            with self.lock:
                self.leases[execution['id']] = execution
        return execution

    def execution(self, execution):
        return api('GET', f'/v1/executions/{execution["id"]}', token=execution['leaseToken'])

    def ready(self, execution):
        until(lambda: self.execution(execution), lambda value: value['state'] == 'RUNNING')

    def command(self, execution, operation, wait=True):
        """每个业务动作只创建一个命令 ID，结果查询不会再次执行动作。"""
        request = {'type': 'execution.command', 'commandId': uuid.uuid4().hex,
                   'timeoutMs': 30_000, 'command': operation}
        api('POST', f'/v1/executions/{execution["id"]}/commands', request, execution['leaseToken'], 202)
        if not wait:
            return request
        result = until(lambda: api('GET', f'/v1/executions/{execution["id"]}/commands/{request["commandId"]}',
                                   token=execution['leaseToken'])['result'])
        assert result['operationStatus'] == 'SUCCEEDED', result
        return request, result

    def directory(self, execution):
        """从真实 Node SQLite 查找会话目录，不猜测 systemd 启动身份。"""
        node = next(node for node in self.nodes if node['id'] == execution['nodeId'])
        with sqlite3.connect(node['root'] / 'state/node.db') as db:
            record = json.loads(db.execute('SELECT record FROM sessions WHERE id=?', [execution['sessionId']]).fetchone()[0])
        return node['root'] / 'state/sessions' / record['launch_id']

    def pids(self, execution):
        directory = self.directory(execution)
        until(lambda: (directory / 'grandchild.pid').exists())
        return [int((directory / name).read_text()) for name in ['daemon.pid', 'grandchild.pid']]

    def cleaned(self, execution, pids):
        """同时检查 API 关闭确认和真实进程消失，避免只断言数据库字段。"""
        until(lambda: self.execution(execution), lambda value: value['closureVerified'])
        until(lambda: all(not Path(f'/proc/{pid}').exists() for pid in pids))
        with self.lock:
            self.leases.pop(execution['id'], None)

    def close(self):
        """清理仅限本次测试创建的服务和目录；失败时先输出服务日志。"""
        self.stopped.set()
        self.worker.join(timeout=10)
        for node in self.nodes:
            if node['process'].poll() is None:
                node['process'].terminate()
                node['process'].wait(timeout=25)
        if self.process and self.process.poll() is None:
            self.stop_api()
        active = subprocess.check_output(['systemctl', '--user', 'list-units', '--state=active,activating,deactivating',
                                          '--plain', '--no-legend', 'proofrun-*.service'], text=True)
        assert not active.strip(), active
        shutil.rmtree(self.root)


def task():
    """模拟上层提交完整目标和标准；控制面不得重新分析或改写它们。"""
    return {'protocolVersion': '0.1', 'taskId': uuid.uuid4().hex, 'objective': '验证固定夹具流程',
            'environment': {'id': 'fixture', 'nodePool': 'internal'}, 'target': {'url': 'http://127.0.0.1/fixture'},
            'acceptanceCriteria': [{'id': 'visible', 'description': '采集页面事实', 'expectedResult': '证据可读',
                                    'evidenceKinds': ['DOM', 'SCREENSHOT']}],
            'budget': {'timeoutMs': 180_000, 'maxActions': 20}}


def run():
    """完整覆盖控制面和真实节点之间的故障边界，页面和判断仍使用夹具。"""
    harness = Harness()
    checks = []
    try:
        # 配对和并发：两台真实 Rust 节点最多同时领取两个会话；不验证真实 VM 网络。
        harness.start_api()
        harness.add_node()
        harness.add_node()
        tasks = [task() for _ in range(3)]
        for definition in tasks:
            api('POST', '/v1/tasks', definition, expected=202)
        with ThreadPoolExecutor(max_workers=3) as workers:
            executions = [value for value in workers.map(lambda _: harness.claim(), range(3)) if value]
        assert len(executions) == 2, executions
        first, second = executions
        harness.ready(first)
        harness.ready(second)
        first_pids, second_pids = harness.pids(first), harness.pids(second)
        checks.append('真实节点配对与全局容量准入')

        # 持久结果：写动作完成后重启 API，以相同 ID 重提不增加假引擎写入计数。
        # 不证明真实 agent-browser 自身不会在丢响应时重试。
        _, observed = harness.command(first, {'type': 'browser.observe', 'screenshot': True})
        request, result = harness.command(first, {'type': 'browser.act', 'action': 'click', 'target': 'element-1',
                                                   'observationId': observed['data']['observationId']})
        harness.stop_api()
        harness.start_api()
        duplicate = api('POST', f'/v1/executions/{first["id"]}/commands', request, first['leaseToken'], 202)
        assert duplicate['result'] == result
        assert (harness.directory(first) / 'writes').read_text() == '1'
        checks.append('API 重启恢复与已完成动作去重')

        # 证据：真实节点上传夹具 PNG，API 核实摘要，报告引用数据库内的真实证据记录。
        # PASSED 仅表达夹具流程完成，不是模型或业务验收。
        state = until(lambda: harness.execution(first), lambda value: len(value['artifacts']) >= 2 and
                      all(artifact['state'] == 'AVAILABLE' for artifact in value['artifacts']), timeout=35)
        artifacts = state['artifacts']
        for artifact in artifacts:
            request_download = Request(BASE + '/v1/artifacts/' + artifact['id'], headers={'authorization': f'Bearer {ADMIN}'})
            with urlopen(request_download, timeout=5) as response:
                assert hashlib.sha256(response.read()).hexdigest() == artifact['sha256']
        report = {'protocolVersion': '0.1', 'taskId': first['task']['taskId'], 'lifecycle': 'COMPLETED',
                  'executionDisposition': 'EXECUTED', 'verdict': 'PASSED', 'summary': '固定夹具交付完成',
                  'criteria': [{'criterionId': 'visible', 'verdict': 'PASSED', 'summary': '证据可追溯',
                                'evidenceRefs': [artifact['id'] for artifact in artifacts]}],
                  'artifacts': [{key: artifact[key] for key in ['id', 'kind', 'sha256']} | {'uri': BASE + '/v1/artifacts/' + artifact['id']}
                                for artifact in artifacts]}
        api('POST', f'/v1/executions/{first["id"]}/complete', {'type': 'execution.complete', 'report': report}, first['leaseToken'])
        harness.cleaned(first, first_pids)
        assert api('GET', '/v1/tasks/' + first['task']['taskId'])['state'] == 'COMPLETED'
        assert all(Path(f'/proc/{pid}').exists() for pid in second_pids)
        checks.append('截图与 DOM 证据交付、报告存档和单会话关闭')

        # 取消：真实 Node 等待中被取消，数据库终态和后代进程回收均得到确认。
        # 假引擎等待是 sleep，不验证真实页面等待条件。
        harness.command(second, {'type': 'browser.wait', 'selector': '#never', 'text': 'ready'}, wait=False)
        time.sleep(.5)
        api('POST', '/v1/tasks/' + second['task']['taskId'] + '/cancel')
        harness.cleaned(second, second_pids)
        third = until(harness.claim)
        harness.ready(third)
        checks.append('取消等待并回收后代，排队任务取得释放容量')

        # 主进程崩溃：假引擎先写一次再延迟响应，SIGKILL 后节点恢复原会话并关闭。
        # 不覆盖主机重启、磁盘损坏或真实引擎内部重试。
        third_pids = harness.pids(third)
        _, observed = harness.command(third, {'type': 'browser.observe'})
        harness.command(third, {'type': 'browser.act', 'action': 'click', 'target': 'element-2',
                               'observationId': observed['data']['observationId']}, wait=False)
        directory = harness.directory(third)
        until(lambda: (directory / 'writes').exists())
        node = next(node for node in harness.nodes if node['id'] == third['nodeId'])
        node['process'].kill()
        node['process'].wait(timeout=5)
        harness.start_node(node)
        harness.cleaned(third, third_pids)
        assert api('GET', '/v1/tasks/' + third['task']['taskId'])['state'] == 'ERROR'
        assert (directory / 'writes').read_text() == '1'
        checks.append('Node 崩溃恢复、不确定写入终止且不重放')
        print(json.dumps({'passed': checks, 'scope': '真实 API / PostgreSQL / Rust / systemd；假浏览器、无模型'}, ensure_ascii=False, indent=2))
    except BaseException:
        for log in harness.root.rglob('*.log'):
            print(log, log.read_text()[-16000:])
        raise
    finally:
        harness.close()


if __name__ == '__main__':
    run()
