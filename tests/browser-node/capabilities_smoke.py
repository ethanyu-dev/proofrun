#!/usr/bin/env python3
"""真实 Chromium 能力回归：独立 session-host 与回环页面，不代表生产 VM 或模型质量验收。"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs
import json
import os
import queue
import subprocess
import tempfile
import threading
import time
import uuid

# 页面主动记录真实写入；隐藏文本用于核实快照不会把不可见内容当作可见事实。
FORM = '''function form(root,prefix){root.innerHTML=`<label>${prefix} name<input></label><button>Save ${prefix}</button><p role="status">Waiting</p>`;root.querySelector('button').onclick=async()=>{const name=root.querySelector('input').value;await fetch('/submit',{method:'POST',body:JSON.stringify({prefix,name})});root.querySelector('p').textContent=`Saved ${prefix} ${name}`;};}'''

class Page(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == '/replace':
            self.server.replace = True
            body = 'ok'
        elif parsed.path == '/poll':
            body = json.dumps(self.server.replace)
        elif parsed.path == '/compound':
            body = (Path(__file__).parent/'fixtures/compound-controls.html').read_text()
        elif parsed.path == '/wujie':
            body = (Path(__file__).parent/'fixtures/wujie-dom.html').read_text()
        elif parsed.path == '/scroll-page':
            body = '<html><body style="margin:60px"><iframe style="width:400px;height:240px" src="/scroll-content"></iframe><iframe style="position:fixed;top:5000px" src="/frame?which=Hidden"></iframe></body></html>'
        elif parsed.path == '/scroll-content':
            body = '''<html><body>
<div id="list" aria-label="Scroll choices" style="height:90px;width:250px;overflow:auto;border:1px solid">
''' + ''.join(f'<button style="display:block;height:40px">Choice {i}</button>' for i in range(15)) + '''</div>
<div style="cursor:pointer">Pointer decoration</div><button disabled>Disabled control</button>
<input aria-label="Read only" readonly value="fixed"><input type="password" aria-label="Password" value="secret-fixture"><button style="position:fixed;top:5000px">Outside viewport</button>
<button style="opacity:0">Transparent control</button><div inert><button>Inert control</button></div>
</body></html>'''
        elif parsed.path == '/frame':
            prefix = parse_qs(parsed.query).get('which', ['Frame'])[0]
            body = f'<html><body><div id="form"></div><script>{FORM}form(document.querySelector("#form"),{json.dumps(prefix)});</script></body></html>'
        elif parsed.path == '/outer':
            body = f'<html><body><iframe id="nested" src="http://localhost:{self.server.server_port}/frame?which=Cross"></iframe></body></html>'
        else:
            body = f'''<!doctype html><html><title>Native DOM fixture</title><body>
<div hidden>HIDDEN_SENTINEL</div><div id="open"></div><div id="closed"></div>
<label>Enabled<input id="check" type="checkbox"></label><select id="choice"><option value="a">Alpha</option><option value="b">Beta</option></select>
<div id="custom" style="cursor:pointer" onclick="this.textContent='Custom clicked'">No ARIA action</div>
<button id="stale">Stale action</button>
<iframe id="same" src="/frame?which=Same"></iframe><iframe id="outer" src="/outer"></iframe>
<div id="visual" style="position:fixed;left:5px;top:5px;width:100px;height:35px;z-index:100;background:red" onclick="this.textContent='Visual clicked'">Visual</div>
<script>{FORM}
const outer=document.querySelector('#open').attachShadow({{mode:'open'}});outer.innerHTML='<section></section>';form(outer.querySelector('section').attachShadow({{mode:'open'}}),'Open');
form(document.querySelector('#closed').attachShadow({{mode:'closed'}}),'Closed');
const timer=setInterval(async()=>{{if(await(await fetch('/poll')).json()){{const old=document.querySelector('#stale');old.replaceWith(old.cloneNode(true));clearInterval(timer);}}}},50);
</script></body></html>'''
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.end_headers()
        self.wfile.write(body.encode())

    def do_POST(self):
        self.server.writes.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'{}')


def run():
    root = Path(tempfile.mkdtemp(prefix='proofrun-capabilities-'))
    server = ThreadingHTTPServer(('127.0.0.1', 0), Page)
    server.writes = []
    server.replace = False
    threading.Thread(target=server.serve_forever, daemon=True).start()
    session = uuid.uuid4().hex
    binary = str(Path(os.environ['PROOFRUN_TEST_BINARY']).resolve())
    log = (root/'stderr.log').open('w')
    process = subprocess.Popen([binary, 'session-host', '--directory', str(root)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, text=True, bufsize=1)
    messages = queue.Queue()
    def read():
        for line in process.stdout:
            messages.put(json.loads(line))
        messages.put(None)
    threading.Thread(target=read, daemon=True).start()
    def send(value):
        process.stdin.write(json.dumps(value)+'\n')
        process.stdin.flush()
    def receive():
        value = messages.get(timeout=45)
        assert value is not None, (root/'stderr.log').read_text()
        return value
    def command(expect_error=False, **operation):
        send({'type':'run', 'command':operation, 'timeout_ms':30000})
        value = receive()['result']
        if expect_error:
            assert 'Err' in value, value
            return value['Err']
        assert 'Ok' in value, value
        return value['Ok']
    def observe():
        return command(type='browser.observe')
    def act(observation, name, action, value=None):
        item = next((t for t in observation['targets'] if t['name']==name and (action not in ['fill','check','uncheck'] or t['role']==('textbox' if action=='fill' else 'checkbox'))),None)
        assert item is not None, (name, observation)
        args = {'type':'browser.act','action':action,'target':item['target'],'observationId':observation['observationId']}
        if value is not None:
            args['value'] = value
        return command(**args)
    try:
        assert receive()['type']=='host.ready'
        boot = int(float(Path('/proc/uptime').read_text().split()[0])*1000)
        send({'type':'init','deadline_ms':boot+300000,'config':{'binary':os.environ['PROOFRUN_AGENT_BROWSER_BIN'],'chrome':os.environ['PROOFRUN_CHROME_BIN'],'session':session,'directory':str(root),'allow_unverified_writes':True}})
        assert 'Ok' in receive()['result']
        # 范围：原始 Chromium timeline 从业务导航前开始到最后操作后停止；不验证文件可靠上传。
        command(type='browser.trace',action='start')
        command(type='browser.act',action='navigate',target=f'http://127.0.0.1:{server.server_port}/')
        first = observe()
        assert 'HIDDEN_SENTINEL' not in first['text']
        # 范围：重新连接 CDP 后真实 backend 身份仍可比较，公开动作编号不能跨轮复用。
        second = observe()
        one = next(t for t in first['targets'] if t['name']=='Stale action')
        two = next(t for t in second['targets'] if t['name']=='Stale action')
        assert one['comparisonKey']==two['comparisonKey'], (one, two)
        assert first['observationId']!=second['observationId']

        # 范围：替换已有文本、空串清空与前导短横线输入；不模拟剪贴板或输入法组合态。
        act(observe(),'Open name','fill','--draft')
        assert any(t.get('value')=='--draft' for t in observe()['targets'])
        act(observe(),'Open name','fill','')
        assert next(t for t in observe()['targets'] if t['name']=='Open name' and t['role']=='textbox')['value']==''
        # 范围：真实 native DOM 节点、两层开放/关闭 shadow roots、同源与嵌套跨域 iframe；服务端计数不证明丢响应重试语义。
        for prefix, value in [('Open','Ada'),('Closed','Lin'),('Same','Mia'),('Cross','Bo')]:
            act(observe(),f'{prefix} name','fill',value)
            act(observe(),f'Save {prefix}','click')
            command(type='browser.wait',selector='[role=status]',text=f'Saved {prefix} {value}')
        assert server.writes==[{'prefix':p,'name':v} for p,v in [('Open','Ada'),('Closed','Lin'),('Same','Mia'),('Cross','Bo')]],server.writes
        # 范围：iframe 观察与条件等待限定同一 frame，返回 main 恢复全页；不覆盖 frame 导航竞态。
        scoped=observe()
        frame=next(t for t in scoped['targets'] if t['name']=='same' and t['role']=='iframe')
        command(type='browser.act',action='frame',target=frame['target'],observationId=scoped['observationId'])
        scoped=observe()
        assert 'Saved Same Mia' in scoped['text'] and 'Closed name' not in scoped['text']
        command(type='browser.wait',selector='[role=status]',text='Saved Same Mia')
        command(type='browser.act',action='frame',target='main',observationId=scoped['observationId'])
        act(observe(),'No ARIA action','click')
        assert 'Custom clicked' in observe()['text']
        act(observe(),'Enabled','check')
        assert 'checked' in observe()['text']
        act(observe(),'Enabled','uncheck')
        act(observe(),'choice','select','b')
        assert 'value="b"' in observe()['text']
        # 范围：后台替换同名元素后旧 target 必须明确拒绝，不能点击新元素。
        before=observe()
        server.replace=True
        time.sleep(.3)
        stale=next(t for t in before['targets'] if t['name']=='Stale action')
        error=command(expect_error=True,type='browser.act',action='click',target=stale['target'],observationId=before['observationId'])
        assert error['code']=='STALE_OBSERVATION' and error['effect']=='NOT_STARTED',error
        # 范围：当前真实 PNG 绑定的视觉点击；截图变化检测不证明所有页面异步变化均可检测。
        visual=command(type='browser.observe',screenshot=True)
        command(type='browser.act',action='visual.click',x=35,y=20,observationId=visual['observationId'])
        assert 'Visual clicked' in observe()['text']
        command(type='browser.act',action='resize',value='1000x700')
        original=observe()
        original_tab=next(t['tabId'] for t in original['tabs'] if t['active'])
        command(type='browser.act',action='tab.new',target=f'http://127.0.0.1:{server.server_port}/frame?which=Tab')
        assert 'Tab name' in observe()['text']
        command(type='browser.act',action='tab.switch',target=original_tab)
        assert 'Saved Closed Lin' in observe()['text']
        # 范围：同进程 iframe 内真实视口过滤与 wheel 命中滚动；不覆盖 CSS 旋转或跨域父框裁剪。
        command(type='browser.act',action='navigate',target=f'http://127.0.0.1:{server.server_port}/scroll-page')
        before=observe()
        names={t['name'] for t in before['targets']}
        assert 'Choice 0' in names and 'Choice 12' not in names, names
        assert not names.intersection({'Pointer decoration','Outside viewport','Transparent control','Save Hidden','Hidden name'}),names
        disabled=next(t for t in before['targets'] if t['name']=='Disabled control')
        assert disabled['disabled'] and disabled['operations']==[]
        inert=next(t for t in before['targets'] if t['name']=='Inert control')
        assert inert['visible'] and inert['inert'] and inert['operations']==[]
        readonly=next(t for t in before['targets'] if t['name']=='Read only')
        assert 'fill' not in readonly['operations']
        password=next(t for t in before['targets'] if t['name']=='Password')
        assert 'fill' in password['operations'] and password['value']=='[redacted]'
        assert 'secret-fixture' not in json.dumps(before)
        container=next(t for t in before['targets'] if t['name']=='Scroll choices')
        assert 'scroll' in container['operations']
        scrolled=command(type='browser.act',action='scroll',target=container['target'],value='down',observationId=before['observationId'])
        assert scrolled['scroll']['moved'] and scrolled['scroll']['after']['y']>0,scrolled
        after=observe()
        names={t['name'] for t in after['targets']}
        assert 'Choice 0' not in names and 'Choice 10' in names,names
        assert after['coverage']['controls']['outsideViewportOrHidden']>0
        # 范围：定向滚动仍绑定观察，滚到底后返回无位移；不将滚动成功等同于业务完成。
        error=command(expect_error=True,type='browser.act',action='scroll',target=container['target'],value='down',observationId=before['observationId'])
        assert error['code']=='STALE_OBSERVATION'
        for expected in [True,False]:
            current=observe()
            container=next(t for t in current['targets'] if t['name']=='Scroll choices')
            result=command(type='browser.act',action='scroll',target=container['target'],value='down',observationId=current['observationId'])
            assert result['scroll']['moved']==expected,result
        # 范围：真实 Chromium 中模拟 Wujie 主世界重写；验证 DOM 身份、填写、点击、选择和滚动，不代表原业务任务验收。
        command(type='browser.act',action='navigate',target=f'http://127.0.0.1:{server.server_port}/wujie')
        current=observe()
        names={t['name'] for t in current['targets']}
        assert {'Wujie name','Wujie action','Wujie select','Wujie choices','Wujie choice 0','Wujie custom leaf'} <= names, names
        # 范围：普通 hidden 裁剪没有 wheel 监听，不能误报可滚动；不覆盖祖先委托的虚拟滚轮实现。
        assert not names.intersection({'Delegated root','Wujie transparent','Wujie choice 12','Clipped only'}),names
        assert current['coverage']['controls']['inspectionWorld']=='isolated'
        assert current['coverage']['controls']['inspectionErrors']==0
        # 范围：隔离真实 Shadow DOM 的表单与列表区域，不证明 portal 能自动关联回所有业务表单。
        assert next(t for t in current['targets'] if t['name']=='Wujie name')['region']['name']=='Sandbox form'
        assert next(t for t in current['targets'] if t['name']=='Wujie choices')['region']['role']=='listbox'
        assert next(t for t in current['targets'] if t['name']=='Wujie choices')['region']['ancestors'][0]['name']=='Sandbox form'
        assert current['coverage']['controls']['delegatedContainers']>=1
        assert current['referenceSnapshot']['source']=='agent-browser' and current['referenceSnapshot']['refCount']>0
        assert 'Wujie action' in current['referenceSnapshot']['text']
        assert next(t for t in current['targets'] if t['name']=='Wujie inert')['operations']==[]
        aria=next(t for t in current['targets'] if t['name']=='Wujie aria hidden')
        assert aria['visible'] and aria['ariaHidden'] and 'click' in aria['operations']
        identity=next(t for t in current['targets'] if t['name']=='Wujie action')['comparisonKey']
        assert identity==next(t for t in observe()['targets'] if t['name']=='Wujie action')['comparisonKey']
        act(observe(),'Wujie name','fill','Ada')
        act(observe(),'Wujie action','click')
        assert 'Wujie clicked Ada' in observe()['text']
        act(observe(),'Wujie select','select','b')
        assert 'Wujie selected b' in observe()['text']
        act(observe(),'Wujie custom leaf','click')
        assert 'Leaf clicked' in observe()['text']
        current=observe()
        container=next(t for t in current['targets'] if t['name']=='Wujie choices')
        assert container['operations']==['scroll'],container
        result=command(type='browser.act',action='scroll',target=container['target'],value='down',observationId=current['observationId'])
        assert result['scroll']['moved'],result
        assert 'Wujie choice 10' in {t['name'] for t in observe()['targets']}
        # 范围：导航使隔离上下文与旧观察失效，不能将旧 target 绑定到新文档。
        command(type='browser.act',action='reload')
        error=command(expect_error=True,type='browser.act',action='scroll',target=container['target'],value='down',observationId=current['observationId'])
        assert error['code']=='STALE_OBSERVATION'
        assert 'Wujie action' in {t['name'] for t in observe()['targets']}
        # 范围：浏览器原生鼠标可通过同一下拉的展示层；真正遮挡和另一个可操作控件仍不得派发。
        command(type='browser.act',action='navigate',target=f'http://127.0.0.1:{server.server_port}/compound')
        act(observe(),'Selected value','click')
        current=observe()
        assert next(t for t in current['targets'] if t['name']=='Selected value')['expanded']=='true'
        assert 'Selected value opened' in current['text']
        for name in ['External overlay','Adjacent button']:
            current=observe()
            item=next(t for t in current['targets'] if t['name']==name)
            error=command(expect_error=True,type='browser.act',action='click',target=item['target'],observationId=current['observationId'])
            assert error['code']=='TARGET_OBSCURED',error
            assert name+' opened' not in observe()['text']
        trace=command(type='browser.trace',action='stop')
        events=json.loads(Path(trace['localTrace']).read_text())['traceEvents']
        assert len(events)>0
        print(json.dumps({'passed':['native DOM without ARIA','nested open and closed Shadow DOM','same-origin and nested cross-origin iframe actions and waits','check/uncheck/select','detached node rejection','fresh screenshot visual input','resize and tabs','stable comparison identities','visible control capabilities','targeted iframe container scroll','isolated Wujie-style DOM and actions','delegated root exclusion','reference snapshot diagnostics','compound combobox hit ownership and overlay rejection','Chromium TRACE'],'businessWrites':len(server.writes),'traceEvents':len(events),'root':str(root)},indent=2))
    finally:
        if process.poll() is None:
            send({'type':'close'})
            process.wait(timeout=20)
        log.close()
        server.shutdown()
        server.server_close()
        assert process.returncode==0,(root/'stderr.log').read_text()

if __name__=='__main__':
    run()
