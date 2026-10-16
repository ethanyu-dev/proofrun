#!/usr/bin/env python3
"""完整 profile 的真实 Chromium 回环夹具；不覆盖 Linux 监管、生产身份、跨节点迁移或 SSO。"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json
import shutil
import tempfile
import threading
import time
from auth_network_smoke import host


class Page(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.end_headers()
        identity = 'member' if 'session=fixture-secret' in self.headers.get('Cookie', '') else 'guest'
        script = ""
        if self.path == '/human':
            script = "localStorage.setItem('team','confirmed-team');"
        elif self.path == '/business':
            script = "localStorage.setItem('team','business-mutation');"
        # IndexedDB 不在普通 Cookie/localStorage 导出中，验证实际复制的是完整目录。
        marker = 'indexed-human' if self.path == '/human' else 'indexed-business' if self.path == '/business' else None
        script += f"""
        const request = indexedDB.open('proofrun-fixture', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('identity');
        request.onsuccess = () => {{
          const db = request.result;
          const tx = db.transaction('identity', 'readwrite');
          const store = tx.objectStore('identity');
          const marker = {json.dumps(marker)};
          if (marker) store.put(marker, 'value');
          store.get('value').onsuccess = event => {{
            const p = document.createElement('p'); p.textContent = event.target.result || 'indexed-empty'; document.body.append(p);
          }};
        }};
        """
        self.wfile.write((f'<title>Profile fixture</title><p>{identity}</p><p id="team"></p><script>{script}document.querySelector("#team").textContent=localStorage.getItem("team")||"no-team";</script>').encode())


def run():
    root = Path(tempfile.mkdtemp(prefix='proofrun-full-profile-'))
    server = ThreadingHTTPServer(('127.0.0.1', 0), Page)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f'http://127.0.0.1:{server.server_port}'
    state = root / 'auth' / 'member.json'
    seed = root / 'seed.json'
    seed.write_text(json.dumps({'url': origin, 'cookies': [{'name': 'session', 'value': 'fixture-secret', 'httpOnly': True}]}))
    seed.chmod(0o600)
    def observe(command, expected, **scope):
        for _ in range(30):
            value = command(type='browser.observe', **scope)
            if expected in value['text']:
                return value['text']
            time.sleep(0.1)
        raise AssertionError(value)
    def prepare(command):
        return command(type='browser.identity.prepare', url=origin + '/', checks=[], saveSnapshot=False)
    try:
        # 范围：注入 Cookie 但不自动发布基准；人工保存后重启仍保留登录和页面状态。
        with host(root, state, True, optional=True, full_profile=True, seed=seed) as command:
            assert prepare(command)['status'] == 'LOADED'
            assert 'member' in command(type='browser.observe')['text']
            assert not state.with_suffix('.profile').joinpath('current.json').exists()
            command(type='browser.trace', action='start')
            command(type='browser.act', action='navigate', target=origin + '/human', tabScope='group-one')
            observe(command, 'indexed-human', tabScope='group-one')
            command(type='browser.act', action='navigate', target=origin + '/other-tab', tabScope='group-two')
            assert command(type='browser.auth.save')['saved']
            observed = observe(command, 'indexed-human', tabScope='group-two')
            assert 'member' in observed and 'confirmed-team' in observed, observed
            assert command(type='browser.observe', tabScope='group-one')['url'].endswith('/human')
            trace = command(type='browser.trace', action='stop')
            events = json.loads(Path(trace['localTrace']).read_text())['traceEvents']
            assert len([event for event in events if event.get('name') == 'proofrun.profile.segment']) == 2
            command(type='browser.act', action='navigate', target=origin + '/business', tabScope='group-one')
            observe(command, 'indexed-business', tabScope='group-one')
        # 范围：任务内变更不会污染基准，旧种子不能覆盖人工基准；此处 Cookie 原文是夹具。
        seed.write_text(json.dumps({'url': origin, 'cookies': [{'name': 'session', 'value': 'stale-secret', 'httpOnly': True}]}))
        with host(root, state, True, optional=True, full_profile=True, seed=seed) as command:
            result = prepare(command)
            assert result['source'] == 'profile', result
            observed = observe(command, 'indexed-human')
            assert 'member' in observed and 'confirmed-team' in observed and 'business-mutation' not in observed, observed
        # 范围：新身份没有共享状态，不会把另一身份基准当作可用账号。
        with host(root, root / 'auth' / 'other.json', True, optional=True, full_profile=True) as command:
            assert prepare(command)['reasonCode'] == 'LOGIN_RECIPE_MISSING'
            assert 'guest' in command(type='browser.observe')['text']
        # 范围：节点模板保存后不重启；新身份无种子时保留会话 Cookie、localStorage 与 IndexedDB。
        # 真实 Chrome 回环测试不经过 Console 鉴权，也不代表生产 SSO 或 Linux 进程监管验收。
        template = root / 'auth' / 'node-default-template.json'
        with host(root, template, True, optional=True, full_profile=True, node_template=True) as command:
            command(type='browser.act', action='navigate', target=origin + '/human')
            command(type='browser.cookies.set', url=origin, name='session', value='fixture-secret', httpOnly=True)
            command(type='browser.act', action='reload')
            observe(command, 'indexed-human')
            result = command(type='browser.auth.save')
            assert result['saved'] and not result['profileRestarted'], result
        empty_seed = root / 'empty-seed.json'
        empty_seed.write_text(json.dumps({'url': origin, 'cookies': []}))
        empty_seed.chmod(0o600)
        inherited_state = root / 'auth' / 'inherited.json'
        with host(root, inherited_state, True, optional=True, full_profile=True, seed=empty_seed, template_state=template) as command:
            assert prepare(command)['reasonCode'] == 'NODE_TEMPLATE_LOADED'
            observed = observe(command, 'indexed-human')
            assert 'member' in observed and 'confirmed-team' in observed, observed
            command(type='browser.act', action='navigate', target=origin + '/business')
            observe(command, 'indexed-business')
        # 范围：任务副本不回写模板，显式 Cookie 种子覆盖目标源登录；不测试跨站 Cookie 属性组合。
        with host(root, root / 'auth' / 'inherited-next.json', True, optional=True, full_profile=True, template_state=template) as command:
            assert prepare(command)['reasonCode'] == 'NODE_TEMPLATE_LOADED'
            assert 'confirmed-team' in observe(command, 'indexed-human')
        with host(root, root / 'auth' / 'seed-override.json', True, optional=True, full_profile=True, seed=seed, template_state=template) as command:
            assert prepare(command)['source'] == 'cookies'
            observed = observe(command, 'guest')
            assert 'confirmed-team' not in observed, observed
        print('full profile smoke: Cookie loading, HITL publish/restart, IndexedDB, tab restoration, trace continuity, immutable baseline, node template inheritance and identity isolation passed')
    finally:
        server.shutdown()
        server.server_close()
        shutil.rmtree(root)


if __name__ == '__main__':
    run()
