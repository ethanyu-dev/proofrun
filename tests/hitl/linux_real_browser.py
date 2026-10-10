#!/usr/bin/env python3
"""真实 Linux 节点、Chromium、画面中转和受限输入；执行者为夹具，不使用真实模型。"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import uuid
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'tests/control-plane'))
from linux_integration import Harness,api,until,BASE,task

class Page(BaseHTTPRequestHandler):
    def log_message(self,*_): pass
    def do_GET(self):
        self.send_response(200); self.send_header('Content-Type','text/html; charset=utf-8'); self.end_headers()
        self.wfile.write('''<html><meta charset="utf-8"><title>HITL fixture</title><form style="position:absolute;left:40px;top:60px"><input aria-label="Account" style="width:300px;height:50px" name="name"><button>Login</button></form><p role="status" style="position:absolute;top:180px"></p><script>document.querySelector('form').onsubmit=async e=>{e.preventDefault();let name=e.target.name.value;await fetch('/save',{method:'POST',body:name});document.querySelector('[role=status]').textContent='Logged in '+name}</script></html>'''.encode())
    def do_POST(self):
        self.server.writes.append(self.rfile.read(int(self.headers['Content-Length'])).decode())
        self.send_response(200);self.end_headers();self.wfile.write(b'{}')

def run():
    harness=Harness();page=ThreadingHTTPServer(('127.0.0.1',0),Page);page.writes=[]
    threading.Thread(target=page.serve_forever,daemon=True).start()
    try:
        harness.start_api();harness.add_node()
        definition=task();definition['environment']['allowIntervention']=True
        # 首次 Agent 导航耗尽预算后，人工点击、输入及按键仍须完成；仅验证本地夹具，不代表真实账号登录验收。
        definition['budget']['maxActions']=1
        definition['target']['url']=f'http://127.0.0.1:{page.server_port}'
        api('POST','/v1/tasks',definition,expected=202)
        execution=harness.claim();harness.ready(execution)
        harness.command(execution,{'type':'browser.act','action':'navigate','target':definition['target']['url']})
        api('POST',f'/v1/executions/{execution["id"]}/intervene',{'type':'execution.intervene','reason':'请完成测试页面登录','items':['填写账号并登录'],'controlRevision':0},execution['leaseToken'])
        api('POST',f'/v1/executions/{execution["id"]}/control',{'type':'execution.control','action':'acknowledge','controlRevision':1},execution['leaseToken'])
        link=api('GET',f'/v1/admin/executions/{execution["id"]}/intervention')['intervention']
        driver=subprocess.run(['node',str(ROOT/'tests/hitl/drive.mjs')],env=dict(os.environ,PROOFRUN_HITL_BASE=BASE,PROOFRUN_HITL_LINK=json.dumps(link)),capture_output=True,text=True,timeout=60)
        assert driver.returncode==0,(driver.stdout,driver.stderr)
        assert page.writes==['--cdp HITL中文'],page.writes
        # 人工操作不计入 Agent 预算；恢复自动执行后仍保留已消耗的一次导航。
        view=harness.execution(execution);assert view['controlMode']=='AUTO' and view['actionCount']==1,view
        command_id=uuid.uuid4().hex
        api('POST',f'/v1/executions/{execution["id"]}/commands',{'type':'execution.command','commandId':command_id,'timeoutMs':15000,'controlRevision':2,'command':{'type':'browser.observe','screenshot':True}},execution['leaseToken'],202)
        result=until(lambda:api('GET',f'/v1/executions/{execution["id"]}/commands/{command_id}',token=execution['leaseToken'])['result'])
        assert 'Logged in --cdp HITL中文' in result['data']['text'],result
        # 人工处理结束仍使用原 session；最终任务取消才回收，避免将处理页关闭当成浏览器关闭。
        assert harness.execution(execution)['state']=='RUNNING'
        api('POST',f'/v1/tasks/{definition["taskId"]}/cancel');harness.cleaned(execution,[])
        print(json.dumps({'passed':['真实 JPEG WebSocket 画面中转','坐标点击、中文与前导短横线输入、按键','独立业务提交一次','完成撤权且原会话继续可观察','最终 systemd 关闭确认'],'driver':json.loads(driver.stdout),'realModel':False,'tls':False},ensure_ascii=False,indent=2))
    except BaseException:
        for log in harness.root.rglob('*.log'): print(log,log.read_text(errors='replace')[-12000:])
        raise
    finally:
        page.shutdown();page.server_close();harness.close()
if __name__=='__main__':run()
