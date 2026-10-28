#!/usr/bin/env python3
"""真实 Chrome 验证两个站点的模板继承、版本更新和副本隔离。
只访问本机夹具，不经过 Linux systemd、生产网站或真实账号登录。
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json
import shutil
import tempfile
import threading
from auth_network_smoke import host


class Page(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        login = self.path.startswith('/login')
        if login:
            self.send_header('Set-Cookie', 'template_session=member; Path=/; SameSite=Lax; HttpOnly')
        self.end_headers()
        authenticated = 'template_session=member' in self.headers.get('Cookie', '')
        self.wfile.write((f'<p>cookie={authenticated}</p><p id="result">loading</p><script>' +
            ("localStorage.setItem('version', '" + ('two' if 'two' in self.path else 'one') + "');" if login else '') +
            "const open=indexedDB.open('profile-fixture',1);open.onupgradeneeded=()=>open.result.createObjectStore('state');open.onsuccess=()=>{const db=open.result;const tx=db.transaction('state','readwrite');const s=tx.objectStore('state');" +
            ("s.put('member','identity');" if login else '') +
            "const read=s.get('identity');read.onsuccess=()=>document.querySelector('#result').textContent='storage='+localStorage.getItem('version')+' indexed='+read.result;};</script>").encode())


def verify(command, url, version, cookie=True):
    command(type='browser.act', action='navigate', target=url + '/verify')
    data = command(type='browser.observe')
    assert f'cookie={cookie}' in data['text'], data
    assert 'storage=' + version in data['text'], data
    assert 'indexed=member' in data['text'], data


def run():
    root = Path(tempfile.mkdtemp(prefix='proofrun-default-profile-'))
    store = root / 'default-profile'
    servers = [ThreadingHTTPServer(('127.0.0.1', 0), Page) for _ in range(2)]
    for server in servers:
        threading.Thread(target=server.serve_forever, daemon=True).start()
    urls = [f'http://{hostname}:{server.server_port}' for hostname, server in zip(['127.0.0.1', 'localhost'], servers)]
    try:
        # 范围：维护会话首次空白，多站点 Cookie/localStorage/IndexedDB 保存；不证明生产站点授权。
        with host(root, profile_root=store, maintenance=True) as command:
            assert command.opened['environmentProof']['initialState'] == 'empty'
            for url in urls:
                command(type='browser.act', action='navigate', target=url + '/login')
                verify(command, url, 'one')
            saved = command(type='session.profile.publish')['profile']
        # 范围：真实任务副本只读继承版本，修改不会污染默认模板；普通任务不能发布。
        with host(root, profile_root=store) as first:
            assert first.opened['environmentProof']['profile']['version'] == saved['version']
            for url in urls:
                verify(first, url, 'one')
            denied = first.raw(type='session.profile.publish')
            assert denied['Err']['code'] == 'PROFILE_PUBLISH_FORBIDDEN', denied
            first(type='browser.cookies.clear', url=urls[0], names=['template_session'])
            verify(first, urls[0], 'one', False)
            # 范围：维护新版本期间既有任务保持原副本；新的副本继承发布后的版本。
            with host(root, profile_root=store, maintenance=True) as edit:
                verify(edit, urls[0], 'one')
                edit(type='browser.act', action='navigate', target=urls[0] + '/login?two')
                updated = edit(type='session.profile.publish')['profile']
                assert updated['version'] != saved['version']
            verify(first, urls[0], 'one', False)
        with host(root, profile_root=store) as command:
            verify(command, urls[0], 'two')
            verify(command, urls[1], 'one')
        # 范围：未指定模板的访客/外部账号底座为空白，不复制节点默认材料。
        with host(root) as command:
            assert command.opened['environmentProof']['initialState'] == 'empty'
            command(type='browser.act', action='navigate', target=urls[0] + '/verify')
            data = command(type='browser.observe')
            assert 'cookie=False' in data['text'] and 'storage=null' in data['text'], data
        print('通过：多站点模板保存、Cookie/localStorage/IndexedDB 继承、任务副本隔离、版本更新与空白会话例外')
    finally:
        for server in servers:
            server.shutdown()
            server.server_close()
        shutil.rmtree(root)


if __name__ == '__main__':
    run()
