#!/usr/bin/env python3
"""真实本地 Chromium 的身份配方、隔离、快照失效和密码登录测试。
仅访问回环 HTTP 夹具；不证明生产域名、第三方 SSO、验证码或 systemd 部署可用。
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json
import shutil
import tempfile
import threading
from auth_network_smoke import host

class Page(BaseHTTPRequestHandler):
    accepted = 'fixture-cookie-secret'
    submissions = 0
    provider_requests = 0
    provider_profile = None
    def log_message(self, *_):
        pass
    def do_GET(self):
        ready = ('session=' + self.accepted) in self.headers.get('Cookie', '')
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.end_headers()
        body = '<p id="ready">Fixture member</p>' if ready else '''<p>Login required</p><form action="/login" method="post"><input id="user"><input id="pass" type="password"><button id="submit">Login</button></form><script>
        document.querySelector('form').addEventListener('submit', async event => {
          event.preventDefault(); const response = await fetch('/login', {method:'POST', body:document.querySelector('#user').value + ':' + document.querySelector('#pass').value});
          if (response.ok) document.body.innerHTML='<p id="ready">Fixture member</p>';
        });</script>'''
        if self.path == '/foreign-form':
            body=body.replace('action="/login"', 'action="https://foreign.invalid/login"')
        self.wfile.write(body.encode())
    def do_POST(self):
        if self.path == '/identity-provider':
            Page.provider_requests += 1
            assert self.headers.get('Authorization') == 'Bearer fixture-provider-token'
            payload=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            assert payload['profileRef']=='external'
            assert payload['origin']==Page.provider_profile['origin']
            self.send_response(200)
            self.end_headers()
            self.wfile.write(json.dumps(Page.provider_profile).encode())
            return
        Page.submissions += 1
        body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
        good = body == b'fixture-user:fixture-password-secret'
        self.send_response(200 if good else 403)
        if good:
            self.send_header('Set-Cookie', 'session='+self.accepted+'; Path=/; HttpOnly; SameSite=Lax')
        self.end_headers()
        self.wfile.write(b'ok')

def run():
    root = Path(tempfile.mkdtemp(prefix='proofrun-identity-'))
    server = ThreadingHTTPServer(('127.0.0.1', 0), Page)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f'http://127.0.0.1:{server.server_port}'
    library = root / 'library.json'
    profiles = {
      'cookie': {'origin':origin, 'login':{'type':'cookies','cookies':[{'name':'session','value':Page.accepted,'httpOnly':True}]}},
      'password': {'origin':origin,'login':{'type':'password','url':origin+'/login','usernameSelector':'#user','passwordSelector':'#pass','submitSelector':'#submit','successSelector':'#ready','username':'fixture-user','password':'fixture-password-secret'}},
    }
    library.write_text(json.dumps({'profiles':profiles}))
    library.chmod(0o600)
    state = root / 'auth' / 'member.json'
    def prepare(command, ref):
        result=command(type='browser.identity.prepare',url=origin+'/',profileRef=ref,checks=[{'method':'text','value':'Fixture member'}],saveSnapshot=True)
        assert 'secret' not in json.dumps(result), result
        return result
    try:
        # 范围：新 profile 注入 Cookie 后核验并保存；输出不含秘密。
        with host(root,state,False,library=library) as command:
            result=prepare(command,'cookie')
            assert result['source']=='cookies' and result['status']=='READY' and result['saved'],result
        # 范围：恢复先核验，不重复登录；独立访客 profile 没有共享 Cookie。
        with host(root,state,True,library=library) as command:
            assert prepare(command,'cookie')['source']=='snapshot'
        with host(root,root/'auth'/'guest.json',False) as command:
            command(type='browser.act',action='navigate',target=origin+'/')
            assert 'Login required' in command(type='browser.observe')['text']
        # 范围：服务端使旧 Cookie 失效，失效快照删除且不给出 READY。
        Page.accepted='replacement-cookie-secret'
        with host(root,state,True,library=library) as command:
            result=prepare(command,'cookie')
            assert result['status']=='NEEDS_HUMAN' and not state.exists(),result
        # 范围：配置的原生表单登录只提交一次，成功标记出现后才返回目标页。
        with host(root,state,False,library=library) as command:
            result=prepare(command,'password')
            assert result['status']=='READY' and result['saved'],result
            assert Page.submissions==1,Page.submissions
        # 范围：错误密码保留人工处理页，不进行第二次提交，也不保存错误身份。
        profiles['password']['login']['password']='invalid-secret'
        library.write_text(json.dumps({'profiles':profiles}))
        with host(root,root/'auth'/'bad.json',False,library=library) as command:
            result=prepare(command,'password')
            assert result['reasonCode']=='LOGIN_CHALLENGE_OR_REJECTED',result
            assert Page.submissions==2,Page.submissions
            observed=json.dumps(command(type='browser.observe'))
            assert 'invalid-secret' not in observed
            assert 'fixture-user' not in observed
        # 范围：表单跨源提交在写入密码前拒绝；不代表第三方脚本的完整安全审计。
        profiles['password']['login']['password']='fixture-password-secret'
        profiles['password']['login']['url']=origin+'/foreign-form'
        library.write_text(json.dumps({'profiles':profiles}))
        with host(root,root/'auth'/'foreign.json',False,library=library) as command:
            result=prepare(command,'password')
            assert result['reasonCode']=='LOGIN_FORM_MISMATCH',result
            assert Page.submissions==2
            assert 'fixture-password-secret' not in json.dumps(command(type='browser.observe'))
        # 范围：节点直接请求外部凭据接口，API/Agent 命令只含引用；真实供应商未接入。
        Page.provider_profile={'origin':origin,'login':{'type':'cookies','cookies':[{'name':'session','value':Page.accepted,'httpOnly':True}]}}
        token=root/'provider-token'
        token.write_text('fixture-provider-token')
        token.chmod(0o600)
        library.write_text(json.dumps({'provider':{'url':origin+'/identity-provider','tokenFile':str(token)}}))
        with host(root,root/'auth'/'external.json',False,library=library) as command:
            result=prepare(command,'external')
            assert result['status']=='READY' and result['source']=='cookies',result
            assert Page.provider_requests==1
        print('identity smoke: cookie, snapshot, guest isolation, invalidation, password and HITL fallback passed')
    finally:
        server.shutdown()
        server.server_close()
        shutil.rmtree(root)

if __name__=='__main__': run()
