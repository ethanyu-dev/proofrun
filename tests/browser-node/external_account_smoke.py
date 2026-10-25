#!/usr/bin/env python3
"""真实 Chrome/CDP 的外部 Cookie 注入；只访问本机夹具，不覆盖 Linux 看门狗或生产登录。"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import tempfile
import threading
from auth_network_smoke import host


class Page(BaseHTTPRequestHandler):
    """用请求 Cookie 判断身份，页面只显示公开结果。"""
    def log_message(self, *_):
        pass

    def do_GET(self):
        authenticated = 'external_session=fixture-private-cookie' in self.headers.get('Cookie', '')
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.end_headers()
        self.wfile.write((f'<title>External fixture</title><p>{"Authenticated" if authenticated else "Guest"}</p>'
                         '<p id="visibility"></p><script>document.querySelector("#visibility").textContent = '
                         'document.cookie.includes("external_session") ? "JS visible" : "HTTP only";</script>').encode())


def run():
    root = Path(tempfile.mkdtemp(prefix='proofrun-external-browser-'))
    server = ThreadingHTTPServer(('127.0.0.1', 0), Page)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f'http://127.0.0.1:{server.server_port}'
    seed = root / 'seed.json'
    material = {'cookies': [{'name': 'external_session', 'value': 'fixture-private-cookie', 'domain': '127.0.0.1',
                            'host_only': True, 'path': '/admin', 'secure': False, 'http_only': True,
                            'same_site': 'Strict', 'expires_at': '2030-01-01T00:00:00Z'}]}
    seed.write_text(json.dumps(material))
    os.chmod(seed, 0o600)
    account = {'leaseId': 'fixture-lease', 'materialVersion': 'v1', 'origin': origin, 'ttlMs': 120000}
    try:
        # 范围：真实原生引擎/CDP 注入、path/httpOnly、私密文件及时删除及拒绝共享保存；不使用真实账号。
        with host(root, seed=seed, external_account=account) as command:
            assert not seed.exists()
            assert command.opened['environmentProof']['initialState'] == 'external'
            assert command.opened['environmentProof']['externalAccount'] == account
            command(type='browser.act', action='navigate', target=origin + '/admin/check')
            text = command(type='browser.observe')['text']
            assert 'Authenticated' in text and 'HTTP only' in text and 'fixture-private-cookie' not in text
            command(type='browser.act', action='navigate', target=origin + '/outside')
            assert 'Guest' in command(type='browser.observe')['text']
            assert command.raw(type='browser.auth.save')['Err']['code'] == 'AUTH_SAVE_RETIRED'
            assert command.raw(type='browser.identity.prepare', url=origin, checks=[], saveSnapshot=False)['Err']['code'] == 'EXTERNAL_ACCOUNT_PREPARATION_FORBIDDEN'
        # 范围：下一个独立浏览器不继承外部 Cookie；不证明部署节点的 cgroup 关闭。
        with host(root) as command:
            command(type='browser.act', action='navigate', target=origin + '/admin/check')
            assert 'Guest' in command(type='browser.observe')['text']
        print(json.dumps({'passed': ['CDP cookie injection', 'path and httpOnly', 'private seed removal',
                                   'external lease receipt', 'baseline save and recipe rejected', 'fresh profile isolation'],
                          'realBrowser': True, 'realDevPass': False, 'productionVM': False}, ensure_ascii=False, indent=2))
    finally:
        server.shutdown()
        server.server_close()
        shutil.rmtree(root)


if __name__ == '__main__':
    run()
