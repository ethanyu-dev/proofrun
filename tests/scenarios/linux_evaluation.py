#!/usr/bin/env python3
"""在独占容器内运行业务测评；脚本模型只验证链路，真实模型模式显式启用。"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = Path('/tmp/proofrun-evaluation-output')
sys.path.insert(0, str(ROOT / 'tests/control-plane'))
from linux_integration import Harness, BASE, ADMIN, WORKER, api


def collect_routing():
    """测量结束后只导出路由诊断字段，不改变耗时或保存完整模型输入及验证码。"""
    rows = []
    activities = []
    for path in (OUTPUT / 'run').glob('*/sample.json'):
        sample = json.loads(path.read_text())
        task_path = path.with_name('task.json')
        if task_path.exists():
            for execution in json.loads(task_path.read_text()).get('executions', []):
                activity = api('GET', f'/v1/admin/executions/{execution["id"]}/activity')
                # 只归档命令状态和动作类型，不导出人工输入或完整观察。
                activities.append({'sampleId': sample['id'], 'executionId': execution['id'],
                                   'commands': activity['commands'], 'limit': activity['limit']})
        for call in sample.get('calls', []):
            row = {'sampleId': sample['id'], 'model': call['model'], 'purpose': call['purpose'], 'callId': call['id']}
            try:
                detail = api('GET', f'/v1/admin/executions/{call["executionId"]}/model-calls/{call["id"]}')
                body = json.loads(detail.get('request') or '{}')
                content = body.get('messages', [{}, {}])[1].get('content')
                context = json.loads(content if isinstance(content, str) else content[0]['text']) if content else {}
                row.update(phase=context.get('state', {}).get('phase'), settlement=context.get('state', {}).get('settlement'))
                response = json.loads(detail.get('response') or '{}')
                decisions = []
                for choice in response.get('choices', []):
                    for call in choice.get('message', {}).get('tool_calls', []):
                        function = call.get('function', {})
                        arguments = json.loads(function.get('arguments') or '{}')
                        decisions.append({'type': function.get('name'), **{
                            key: arguments[key] for key in ['action', 'target', 'selector', 'text'] if key in arguments}})
                row['decisions'] = decisions
            except Exception as error:
                row['diagnosticError'] = type(error).__name__
            rows.append(row)
    (OUTPUT / 'routing.json').write_text(json.dumps(rows, ensure_ascii=False, indent=2))
    (OUTPUT / 'activity.json').write_text(json.dumps(activities, ensure_ascii=False, indent=2))


class SmokeModel(BaseHTTPRequestHandler):
    """支持冒烟及 E07 等待恢复；读取真实观察，不访问隐藏状态或判定器。"""
    def log_message(self, *_):
        pass

    def do_POST(self):
        try:
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            content = body['messages'][1]['content']
            ctx = json.loads(content if isinstance(content, str) else content[0]['text'])
            if self.server.wait_started is not None and self.server.wait_recovered_ms is None:
                assert 'BROWSER_WAIT_NOT_MET' in json.dumps(ctx.get('feedback', []))
                self.server.wait_recovered_ms = int((time.monotonic() - self.server.wait_started) * 1000)
            observation = ctx['page']
            text = observation['text']
            refs = [item['artifactId'] for item in observation['artifactRefs']]
            cleanup = ctx['state']['phase'] == 'CLEANUP'
            targets = observation['targets']
            def act(name, action='click', value=None):
                target = next(t['target'] for t in targets if t['name'] == name and t['role'] == ('textbox' if action == 'fill' else 'button'))
                decision = {'type': 'browser.act', 'action': action, 'target': target}
                if value is not None:
                    decision['value'] = value
                return decision
            if cleanup and '记录不存在' not in text:
                decision = act('查询记录' if '已删除' in text else '删除记录')
            elif '记录不存在' in text or '已保存名称 Atlas' in text:
                decision = {'type': 'verification.finish', 'summary': '依据真实查询结果判断',
                            'criteria': [{'criterionId': c['id'], 'verdict': 'PASSED' if cleanup or '已保存名称 Atlas' in text else 'FAILED',
                                          'summary': '实际查询结果见引用证据', 'evidenceRefs': refs} for c in ctx['task']['criteria']],
                            'progress': {'requirements': [{'id': r['id'], 'status': 'complete', 'summary': '已完成查询', 'evidenceRefs': refs}
                                                          for r in ctx['task']['requirements']]}}
            elif self.server.wait_recovery and self.server.wait_started is None and (
                    '保存成功' in text or '正在处理' in text):
                # 范围：故意给出永不出现的条件，验证真实节点提前返回及 Agent 重新观察；不测试模型质量。
                self.server.wait_started = time.monotonic()
                decision = {'type': 'browser.wait', 'selector': 'body', 'text': '永不出现的等待条件'}
            elif '保存成功' in text:
                decision = act('查询记录')
            elif any(t.get('value') == 'Atlas' for t in targets if t['role'] == 'textbox'):
                decision = act('保存')
            else:
                decision = act('名称', 'fill', 'Atlas')
            if 'criteria' in decision:
                decision.setdefault('progress', {})['criteria'] = decision.pop('criteria')
            response = {'choices': [{'finish_reason': 'tool_calls', 'message': {'role': 'assistant', 'tool_calls': [
                {'type': 'function', 'function': {'name': decision.pop('type').replace('.', '_'), 'arguments': json.dumps(decision)}}]}}],
                        'usage': {'prompt_tokens': 100, 'completion_tokens': 30}}
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(response).encode())
        except Exception as error:
            self.server.errors.append(type(error).__name__)
            self.send_response(500)
            self.end_headers()
            self.wfile.write(b'{}')


def run():
    """同一环境声明由本进程实际启动配置生成，结果离开容器前核实 systemd 清理。"""
    OUTPUT.mkdir(mode=0o700)
    harness = Harness()
    fixture = agent = model = None
    agent_log = None
    kind = os.environ.get('PROOFRUN_EVAL_MODEL_KIND', 'scripted')
    mode = os.environ.get('PROOFRUN_EVAL_MODE', 'llm')
    assert kind in ['real', 'scripted'] and mode == 'llm'
    suite = os.environ.get('PROOFRUN_EVAL_SUITE', 'smoke')
    assert kind == 'real' or (mode == 'llm' and suite in ['smoke', 'E01', 'E07', 'E08', 'E12'])
    try:
        profile = {'environment': {'id': 'isolated-evaluation', 'nodePool': 'internal', 'allowIntervention': True, 'reuseAuth': False},
                   'executionMode': mode, 'budget': {'maxActions': 60}, 'evidenceKinds': ['DOM', 'SCREENSHOT']}
        profile_file = harness.root / 'profile.json'
        profile_file.write_text(json.dumps(profile))
        os.environ['PROOFRUN_CASE_PROFILE_FILE'] = str(profile_file)
        harness.start_api()
        harness.add_node()
        env = dict(os.environ, PROOFRUN_EVAL_FIXTURE_DIRECTORY=str(harness.root / 'fixture'),
                   PROOFRUN_EVAL_FIXTURE_SOCKET=str(harness.root / 'fixture.sock'))
        fixture = subprocess.Popen(['node', 'tests/scenarios/fixture/server.mjs'], env=env, stdout=subprocess.PIPE, text=True)
        port = json.loads(fixture.stdout.readline())['port']
        env.update(PROOFRUN_CONTROL_URL=BASE, PROOFRUN_ADMIN_TOKEN=ADMIN, PROOFRUN_WORKER_TOKEN=WORKER,
                   PROOFRUN_EVAL_FIXTURE_URL=f'http://127.0.0.1:{port}', PROOFRUN_AGENT_COMMAND_MS='25000')
        if kind == 'scripted':
            model = ThreadingHTTPServer(('127.0.0.1', 0), SmokeModel)
            model.errors = []
            model.wait_recovery = suite == 'E07'
            model.wait_started = model.wait_recovered_ms = None
            threading.Thread(target=model.serve_forever, daemon=True).start()
            env.update(PROOFRUN_MODEL_BASE_URL=f'http://127.0.0.1:{model.server_port}/v1', PROOFRUN_MODEL_API_KEY='fixture-only',
                       PROOFRUN_MODEL='local-evaluation-fixture', PROOFRUN_MODEL_VISION='true')
        else:
            assert env.get('PROOFRUN_MODEL_BASE_URL') and env.get('PROOFRUN_MODEL_API_KEY') and env.get('PROOFRUN_MODEL')
        # 代理配置显式传入，避免把出口变化归因于模型效果；凭据只记摘要。
        proxy = env.get('PROOFRUN_EVAL_HTTPS_PROXY')
        if proxy:
            parsed_proxy = urlparse(proxy)
            assert parsed_proxy.scheme in ['http', 'https'] and parsed_proxy.hostname
            env.update(NODE_USE_ENV_PROXY='1', HTTPS_PROXY=proxy, NO_PROXY='localhost,127.0.0.1,::1')
        settings = {key: env.get(key) for key in ['PROOFRUN_MODEL_BASE_URL', 'PROOFRUN_MODEL_MAX_TOKENS',
                    'PROOFRUN_MODEL_THINKING', 'PROOFRUN_MODEL_REASONING_EFFORT', 'PROOFRUN_MODEL_TOKEN_PARAMETER']}
        if proxy:
            settings['proxySha256'] = hashlib.sha256(proxy.encode()).hexdigest()
        environment = {'mode': mode, 'modelKind': kind, 'model': env['PROOFRUN_MODEL'],
                       'vision': env.get('PROOFRUN_MODEL_VISION', 'false') == 'true',
                       'network': 'explicit-env-proxy' if proxy else 'runtime-default',
                       'configSha256': hashlib.sha256(json.dumps({'profile': profile, 'settings': settings}, sort_keys=True).encode()).hexdigest()}
        environment_file = OUTPUT / 'environment.json'
        environment_file.write_text(json.dumps(environment))
        agent_log = (harness.root / 'agent.log').open('wb')
        agent = subprocess.Popen(['node', 'apps/agent/dist/main.js', 'serve'], env=env, stdout=agent_log, stderr=agent_log)
        command = ['node', 'scripts/evaluate-e2e.mjs', '--output', str(OUTPUT / 'run'), '--environment', str(environment_file),
                   '--suite', suite, '--repeat', os.environ.get('PROOFRUN_EVAL_REPEAT', '1'),
                   '--sample-ms', os.environ.get('PROOFRUN_EVAL_SAMPLE_MS', '600000'),
                   '--max-calls', os.environ.get('PROOFRUN_EVAL_MAX_CALLS', '2000')]
        if kind == 'scripted':
            # 范围：编排器进程死亡后的真实 API 对账；不冒充引擎内部响应丢失测试。
            runner = subprocess.Popen(command, env=env)
            deadline = time.monotonic() + 60
            original = None
            try:
                while time.monotonic() < deadline and runner.poll() is None:
                    for path in (OUTPUT / 'run').glob('*/sample.json'):
                        value = json.loads(path.read_text())
                        if value.get('taskId') and not value.get('result'):
                            original = value
                            break
                    if original:
                        break
                    time.sleep(.05)
                assert original, '未捕获可恢复的已提交任务'
            finally:
                if runner.poll() is None:
                    runner.kill()
                runner.wait()
            # 仅在刚刚创建的进程已 wait 确认退出后移除它的锁，不抢占其他运行器。
            lock = OUTPUT / 'run/runner.lock'
            assert json.loads(lock.read_text())['pid'] == runner.pid
            lock.unlink()
            result = subprocess.run(command + ['--resume'], env=env)
            recovered = json.loads((OUTPUT / 'run' / original['id'] / 'sample.json').read_text())
            assert recovered['taskId'] == original['taskId']
            (OUTPUT / 'recovery-check.json').write_text(json.dumps({'originalTaskId': original['taskId'],
                'recoveredTaskId': recovered['taskId'], 'sameTask': True, 'boundary': 'evaluation-runner-process'}))
        else:
            result = subprocess.run(command, env=env)
        if model:
            (OUTPUT / 'scripted-model-errors.json').write_text(json.dumps(model.errors))
            if model.wait_recovery:
                assert not model.errors, model.errors
                assert result.returncode == 0
                assert model.wait_recovered_ms is not None and model.wait_recovered_ms < 15000
                (OUTPUT / 'wait-recovery-check.json').write_text(json.dumps({
                    'recovered': True, 'elapsedMs': model.wait_recovered_ms,
                    'scope': '真实节点与浏览器、脚本模型；错误等待后重观察，业务判定器检查单次提交和查询'}))
        collect_routing()
        return result.returncode
    finally:
        if agent and agent.poll() is None:
            agent.terminate()
            try:
                agent.wait(timeout=30)
            except subprocess.TimeoutExpired:
                agent.kill()
                agent.wait()
        if agent_log:
            agent_log.close()
        if fixture:
            fixture.terminate()
            fixture.wait(timeout=10)
        if model:
            model.shutdown()
            model.server_close()
        # Harness.close 对实际用户服务做独立断言；失败不会生成伪造的关闭成功回执。
        harness.close()
        (OUTPUT / 'runtime-check.json').write_text(json.dumps({'systemdServicesClosed': True}))


if __name__ == '__main__':
    sys.exit(run())
