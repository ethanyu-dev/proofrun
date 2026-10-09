#!/usr/bin/python3
"""故障夹具：让 daemon 后代脱离 CLI 并忽略 SIGTERM，以测试 cgroup 回收。

返回值和截图均为固定模拟数据；不能用于验证真实 Chrome 页面或引擎内部重试。
"""
import base64
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

if '--daemon' in sys.argv or '--grandchild' in sys.argv:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    if '--daemon' in sys.argv:
        child = subprocess.Popen([sys.executable, __file__, '--grandchild'], start_new_session=True)
        Path('grandchild.pid').write_text(str(child.pid))
    while True:
        time.sleep(1)

if '--version' in sys.argv:
    print('agent-browser 0.38.1')
    raise SystemExit(0)

args = sys.argv[sys.argv.index('--json') + 1:]
operation = args[0]
data = {}
if operation == 'open':
    if not Path('daemon.pid').exists():
        child = subprocess.Popen([sys.executable, __file__, '--daemon'], stdin=subprocess.DEVNULL,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        Path('daemon.pid').write_text(str(child.pid))
    Path('url').write_text(args[1])
elif operation == 'snapshot':
    data = {'snapshot': '- button "Save" [ref=e1]', 'refs': {'e1': {'role': 'button', 'name': 'Save'}, 'e2': {'role': 'button', 'name': 'Slow save'}}}
elif operation == 'get':
    data = {args[1]: Path('url').read_text() if args[1] == 'url' else 'Fixture'}
elif operation in ['fill', 'click', 'press', 'scroll']:
    path = Path('writes')
    path.write_text(str(int(path.read_text()) + 1 if path.exists() else 1))
    if '@e2' in args:
        time.sleep(30)
elif operation == 'wait':
    time.sleep(30)
# 范围：仅允许可续期会话初始化视口及流服务；不提供真实画面或浏览器交互。
elif operation == 'set':
    data = {}
elif operation == 'stream':
    data = {'enabled': True}
# 范围：固定视口仅支撑截图管道夹具，不模拟真实布局或视觉命中。
elif operation == 'eval':
    data = {'result': {'url': 'http://fixture/', 'width': 1280, 'height': 720, 'x': 0, 'y': 0}}
elif operation == 'screenshot':
    Path(args[1]).write_bytes(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII='))
elif operation != 'close':
    print(json.dumps({'success': False, 'error': 'unsupported fixture operation'}))
    raise SystemExit(1)
print(json.dumps({'success': True, 'data': data}))
