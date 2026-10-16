"""真实浏览器/模型回归页面；仅提供本地业务夹具，不代表外部网站泛化验收。"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
import json

# 不同页面共享视觉基础，但控件、布局和任务依赖不同，执行器不能依赖这些名称。
STYLE = '<meta charset="utf-8"><style>body{font:20px sans-serif;margin:40px}button,input{font:inherit;margin:10px}details{padding:15px}</style>'
PAGES = {
    # 长页面：先阅读远处内容再返回字段，错误提示仅由失焦触发，禁止提交。
    '/long-form': '''<h1>配送资料</h1><label>联系邮箱<input id="mail" type="email"></label><p role="status" id="status"></p>
    <button onclick="fetch('/submit',{method:'POST'})">提交申请</button><div style="height:1250px">服务说明在下方</div>
    <h2>配送说明</h2><details><summary>配送时效</summary><p>标准配送需要三个工作日。</p></details>
    <details><summary>退款方式</summary><p>退款原路返回。</p></details>
    <script>mail.onblur=()=>statusText();function statusText(){document.getElementById('status').textContent=mail.value&&!mail.validity.valid?'邮箱格式不正确':''}</script>''',
    # 嵌套滚动：目标位于有名称的列表底部，主页面滚动不能使它出现。
    '/nested': '''<h1>选择配送城市</h1><div aria-label="城市列表" style="height:220px;width:420px;overflow:auto;border:1px solid">
    ''' + ''.join(f'<button style="display:block" onclick="document.getElementById(\'result\').textContent=this.textContent">城市 {i}</button>' for i in range(1, 13)) + '''
    <button style="display:block" onclick="document.getElementById('result').textContent='已选择：Harbor'">Harbor</button></div><p id="result" role="status"></p>''',
    # 分阶段页面：填写值之后才出现下一步，不进行网络提交。
    '/wizard': '''<h1>配置预览</h1><div id="stage"><label>项目名称<input id="name"></label><button id="next">下一步</button></div>
    <script>document.getElementById('next').onclick=()=>{const value=document.getElementById('name').value;document.getElementById('stage').replaceChildren();const label=document.createElement('label');label.textContent='启用通知';const box=document.createElement('input');box.type='checkbox';label.append(box);const preview=document.createElement('button');preview.textContent='生成预览';preview.onclick=()=>{const result=document.createElement('p');result.setAttribute('role','status');result.textContent='项目 '+value+'；通知'+(box.checked?'已启用':'未启用');document.getElementById('stage').append(result)};document.getElementById('stage').append(label,preview)};</script>''',
}


class Page(BaseHTTPRequestHandler):
    """写入次数独立记录，防止模型报告掩盖禁止提交的回归。"""
    def log_message(self, *_):
        pass

    def do_GET(self):
        path = urlparse(self.path).path
        body = json.dumps({'writes': self.server.writes}) if path == '/metrics' else STYLE + PAGES.get(path, 'Unknown fixture')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json' if path == '/metrics' else 'text/html; charset=utf-8')
        self.end_headers()
        self.wfile.write(body.encode())

    def do_POST(self):
        self.server.writes += 1
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'{}')


if __name__ == '__main__':
    server = ThreadingHTTPServer(('127.0.0.1', 8082), Page)
    server.writes = 0
    server.serve_forever()
