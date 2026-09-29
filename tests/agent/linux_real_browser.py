#!/usr/bin/env python3
"""真实 Agent/API/PostgreSQL/Rust/systemd/Chromium；模型回复由 HTTP 脚本夹具生成。

证明协议、页面操作、实际业务写入和证据链；不证明真实模型成功率、真实内网或引擎丢响应不重试。
"""
import base64
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tests/control-plane'))
sys.path.insert(0, str(ROOT / 'tests/browser-node'))
from linux_integration import Harness, api, until, BASE, ADMIN, WORKER, task
from real_engine_smoke import Fixture

# 决策顺序仅属于测试模型夹具；产品执行器没有写死页面、选择器或验收结论。
STEPS = [('fill', 'Plain name', 'Ada'), ('click', 'Save Plain', None), ('wait', None, 'Saved Plain Ada'),
         ('fill', 'Shadow name', 'Lin'), ('click', 'Save Shadow', None), ('wait', None, 'Saved Shadow Lin')]


class ModelFixture(BaseHTTPRequestHandler):
    """从每次模型请求中的真实观察选择目标，最终结论必须引用本次生成的证据。"""
    def log_message(self, *_):
        pass

    def do_POST(self):
        try:
            assert self.path == '/v1/chat/completions'
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            assert body['model'] == 'local-protocol-fixture'
            assert body['parallel_tool_calls'] is False
            content = body['messages'][1]['content']
            context = json.loads(content[0]['text'])
            image = content[1]['image_url']['url']
            assert base64.b64decode(image.split(',', 1)[1]).startswith(b'\x89PNG\r\n\x1a\n')
            turn = len(self.server.contexts)
            self.server.contexts.append(context)
            if turn < len(STEPS):
                action, name, value = STEPS[turn]
                if action == 'wait':
                    decision = {'type': 'browser.wait', 'selector': '[role="status"]', 'text': value}
                else:
                    role = 'textbox' if action == 'fill' else 'button'
                    target = next(item['target'] for item in context['observation']['targets'] if item['role'] == role and item['name'] == name)
                    decision = {'type': 'browser.act', 'action': action, 'target': target}
                    if value:
                        decision['value'] = value
            else:
                assert 'Saved Plain Ada' in context['observation']['text'], context['observation']['text']
                assert 'Saved Shadow Lin' in context['observation']['text'], context['observation']['text']
                refs = [item['artifactId'] for item in context['observation']['artifactRefs']]
                decision = {'type': 'verification.finish', 'summary': '真实页面夹具的两个表单均显示提交成功',
                            'criteria': [{'criterionId': c['id'], 'verdict': 'PASSED', 'summary': c['expectedResult'], 'evidenceRefs': refs}
                                         for c in context['task']['acceptanceCriteria']]}
            response = {'choices': [{'finish_reason': 'tool_calls', 'message': {'role': 'assistant', 'tool_calls': [
                {'type': 'function', 'function': {'name': decision['type'].replace('.', '_'), 'arguments': json.dumps({k: v for k, v in decision.items() if k != 'type'})}}]}}],
                        'usage': {'prompt_tokens': 100, 'completion_tokens': 30}}
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(response).encode())
        except BaseException as error:
            self.server.errors.append(repr(error))
            self.send_response(500)
            self.end_headers()
            self.wfile.write(b'{}')


def run():
    """一次完整场景验证普通 DOM 和两层开放 Shadow DOM，并用页面服务独立计数。"""
    harness = Harness()
    page = ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
    page.writes = []
    model = ThreadingHTTPServer(('127.0.0.1', 0), ModelFixture)
    model.contexts, model.errors = [], []
    for server in [page, model]:
        threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        harness.start_api()
        harness.add_node()
        definition = task()
        definition.update(objective='填写普通表单 Ada 和 Shadow 表单 Lin，分别提交并验证成功提示',
                          target={'url': f'http://127.0.0.1:{page.server_port}'},
                          acceptanceCriteria=[{'id': prefix.lower(), 'description': f'{prefix} 表单提交',
                                               'expectedResult': f'Saved {prefix} {value}', 'evidenceKinds': ['DOM', 'SCREENSHOT']}
                                              for prefix, value in [('Plain', 'Ada'), ('Shadow', 'Lin')]],
                          budget={'timeoutMs': 240000, 'maxActions': 8})
        api('POST', '/v1/tasks', definition, expected=202)
        env = dict(os.environ, PROOFRUN_CONTROL_URL=BASE, PROOFRUN_WORKER_TOKEN=WORKER,
                   PROOFRUN_MODEL_BASE_URL=f'http://127.0.0.1:{model.server_port}/v1', PROOFRUN_MODEL_API_KEY='fixture-only',
                   PROOFRUN_MODEL='local-protocol-fixture', PROOFRUN_MODEL_VISION='true', PROOFRUN_AGENT_COMMAND_MS='25000')
        worker = subprocess.run(['node', str(ROOT / 'apps/agent/dist/main.js'), 'once'], env=env, capture_output=True, text=True, timeout=230)
        assert worker.returncode == 0, (worker.stdout, worker.stderr)
        state = until(lambda: api('GET', '/v1/tasks/' + definition['taskId']), lambda value: value['report'] and all(e['closure_verified'] for e in value['executions']))
        assert state['state'] == 'COMPLETED', (state, model.errors, worker.stderr)
        report = state['report']
        assert report['verdict'] == 'PASSED', (report, model.errors)
        assert report['executionDetails']['modelCalls'] == 7, report
        assert report['executionDetails']['actions'] == 5, report
        assert not model.errors, model.errors
        assert page.writes == [{'prefix': 'Plain', 'name': 'Ada'}, {'prefix': 'Shadow', 'name': 'Lin'}], page.writes
        for artifact in report['artifacts']:
            with urlopen(Request(artifact['uri'], headers={'authorization': f'Bearer {ADMIN}'}), timeout=5) as response:
                assert hashlib.sha256(response.read()).hexdigest() == artifact['sha256']
        details = report['executionDetails']
        print(json.dumps({'passed': ['可配置模型 HTTP 与真实 worker CLI', '普通表单和两层开放 Shadow DOM',
                                    '完整观察包含非交互成功文本', '两次独立计数业务写入', '真实 PNG 与 DOM 上传及摘要核实',
                                    '逐项报告与 systemd 关闭确认'], 'metrics': details,
                          'artifacts': len(report['artifacts']), 'scope': '本地 Linux/Chromium；脚本模型，非真实模型或内网 VM'}, ensure_ascii=False, indent=2))
    except BaseException:
        for log in harness.root.rglob('*.log'):
            print(log, log.read_text()[-12000:])
        raise
    finally:
        for server in [page, model]:
            server.shutdown()
            server.server_close()
        harness.close()


if __name__ == '__main__':
    run()
