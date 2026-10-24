#!/usr/bin/env python3
"""真实 CLI/Chrome 的人工点击与后台网络证据隔离回归。
使用本地页面、隔离 profile 和直接 host 管道；不访问 Novita，也不替代生产节点日志。
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import tempfile
import threading
import time

from auth_network_smoke import host

# 后台渲染阻塞时间超过人工操作的十五秒预算，用于稳定复现跨标签页等待。
BUSY_MS = 22000
# 夹具只接受回环请求；所有事件均用于独立确认页面实际收到输入。
ARM = threading.Event()
BUSY = threading.Event()
CLICKED = threading.Event()
RELEASE_API = threading.Event()
WRITES = []


class Page(BaseHTTPRequestHandler):
    """提供忙碌后台页、接口一直等待的前台页和独立点击计数。"""
    def log_message(self, *_):
        pass

    def do_GET(self):
        if self.path == '/arm':
            ARM.wait(timeout=30)
        if self.path == '/busy':
            BUSY.set()
        if self.path == '/pending-api':
            RELEASE_API.wait(timeout=30)
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.end_headers()
        if self.path == '/background':
            body = f'''<script>fetch('/arm').then(() => {{
              fetch('/busy'); const end = Date.now() + {BUSY_MS};
              while (Date.now() < end) {{}}
            }})</script>'''
        elif self.path == '/foreground':
            body = '''<button style="width:200px;height:100px" onclick="
              fetch('/clicked', {method:'POST'}); this.textContent='Clicked';
            ">Click</button><script>fetch('/pending-api')</script>'''
        else:
            body = '{}'
        try:
            self.wfile.write(body.encode())
        except BrokenPipeError:
            pass

    def do_POST(self):
        WRITES.append(self.path)
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'{}')
        CLICKED.set()


def run():
    """后台暂停不拖住前台点击，同时仍采集新请求并丢弃旧身份的旁路证据。"""
    server = ThreadingHTTPServer(('127.0.0.1', 0), Page)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    root = Path(tempfile.mkdtemp(prefix='proofrun-input-network-'))
    foreground = f'http://localhost:{server.server_port}'
    background = f'http://127.0.0.1:{server.server_port}'
    try:
        # 范围：真实 Chromium 两个站点渲染进程、网络订阅与一次人工点击；不验证真实业务登录。
        with host(root) as command:
            command(type='browser.act', action='navigate', target=background + '/background')
            command(type='browser.act', action='tab.new', target=foreground + '/foreground')
            ARM.set()
            assert BUSY.wait(timeout=10), '后台页未进入阻塞夹具'
            started = time.monotonic()
            command(type='browser.input', action='click', x=50, y=50)
            elapsed = time.monotonic() - started
            assert elapsed < 10, f'点击仍受后台渲染阻塞: {elapsed}'
            assert CLICKED.wait(timeout=5), '没有收到页面实际点击请求'
            assert WRITES == ['/clicked'], WRITES
            RELEASE_API.set()
            # 范围：失效后只返回当前 tab 新的点击请求，旧导航和背景请求均不能作为身份事实。
            observation = command(type='browser.observe')
            assert 'Clicked' in observation['text'], observation['text']
            requests = observation['network']['requests']
            assert any(r['url'] == foreground + '/clicked' and r.get('status') == 200 for r in requests), requests
            assert all('/background' not in r['url'] and '/busy' not in r['url'] for r in requests), requests
            print(json.dumps({'passed': ['background renderer cannot block foreground input',
                                          'pending API request does not block click',
                                          'one independently counted click',
                                          'fresh foreground network evidence'],
                              'clickSeconds': elapsed, 'root': str(root)}, indent=2))
    finally:
        ARM.set()
        RELEASE_API.set()
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    run()
