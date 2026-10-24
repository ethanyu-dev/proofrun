#!/usr/bin/env python3
"""真实 Chromium 的同 profile tab 隔离及共享存储回归；只访问回环夹具，不代表生产站点或模型验收。"""
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
        if self.path == '/login':
            self.send_header('Set-Cookie', 'fixture_session=member; Path=/; SameSite=Lax')
        self.end_headers()
        self.wfile.write(('<input aria-label="名称"><p>'+self.path+'</p><script>'+
            ("localStorage.setItem('team','fixture');" if self.path == '/login' else '')+
            "document.body.append(document.cookie.includes('fixture_session=member') && localStorage.getItem('team') === 'fixture' ? ' 已登录' : ' 未登录');</script>").encode())

def run():
    root = Path(tempfile.mkdtemp(prefix='proofrun-tabs-'))
    server = ThreadingHTTPServer(('127.0.0.1', 0), Page)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{server.server_port}'
    try:
        with host(root) as command:
            # 范围：首组登录后另一个 tab 共享 Cookie/localStorage，各自只返回自己的 tab。
            command(type='browser.act', action='navigate', target=base+'/login', tabScope='a')
            a = command(type='browser.observe', tabScope='a')
            command(type='browser.act', action='navigate', target=base+'/verify', tabScope='b')
            b = command(type='browser.observe', tabScope='b')
            assert '已登录' in a['text'] and '已登录' in b['text'], (a, b)
            assert len(a['tabs']) == len(b['tabs']) == 1
            assert a['tabs'][0]['tabId'] != b['tabs'][0]['tabId']
            # 范围：切换过其他组后仍可使用本组观察引用，不把 a 的填写发到 b。
            target = next(item['target'] for item in a['targets'] if item.get('name') == '名称')
            command(type='browser.act', action='fill', target=target, value='仅甲组', observationId=a['observationId'], tabScope='a')
            current_a = command(type='browser.observe', tabScope='a')
            current_b = command(type='browser.observe', tabScope='b')
            assert current_a['url'].endswith('/login') and current_b['url'].endswith('/verify')
            assert '仅甲组' in json.dumps(current_a, ensure_ascii=False)
            assert '仅甲组' not in json.dumps(current_b, ensure_ascii=False)
        # 范围：全新临时 profile 不继承前一会话状态；不验证任何已退役的认证保存能力。
        with host(root) as command:
            command(type='browser.act', action='navigate', target=base+'/verify', tabScope='a')
            assert '未登录' in command(type='browser.observe', tabScope='a')['text']
        print('通过：真实 tab 路由、元素引用隔离、同 profile 共享登录、跨 profile 隔离')
    finally:
        server.shutdown()
        server.server_close()
        shutil.rmtree(root)

if __name__ == '__main__':
    run()
