import { createServer } from 'node:http';

/** 本地被测业务页面；实际表单请求有独立审计，不模拟浏览器、模型或 ProofRun 回执。 */
const HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>ProofRun 联调记录</title></head>
<body><h1>联调记录</h1><p>本页面无需登录。</p>
<form><label>记录名称 <input name="name" required></label><button type="submit">保存记录</button></form>
<p role="status" id="status">正在加载</p><ul id="records"></ul><button id="clear" type="button">删除记录</button>
<script>
async function render() {
 const {records}=await fetch('/records').then(r=>r.json());
 document.querySelector('#records').replaceChildren(...records.map(name=>{const li=document.createElement('li');li.textContent=name;return li;}));
 document.querySelector('#status').textContent=records.length ? '已保存 '+records[0]+'；记录数：'+records.length : '暂无记录；记录数：0';
}
document.querySelector('form').onsubmit=async event=>{event.preventDefault();await fetch('/records',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:new FormData(event.target).get('name')})});await render();};
document.querySelector('#clear').onclick=async()=>{await fetch('/records',{method:'DELETE'});await render();};
render();
</script></body></html>`;

/** 每次联调使用独立内存状态；audit 只由宿主读取，不提供修改接口。 */
export function createSite() {
  const audit = { records: [], writes: [], reads: 0 };
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    if (request.url === '/records') {
      response.setHeader('Content-Type', 'application/json');
      if (request.method === 'POST') {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const value = JSON.parse(Buffer.concat(chunks).toString());
        if (typeof value.name !== 'string' || value.name.length > 100) {
          response.writeHead(400).end('{}');
          return;
        }
        audit.records.push(value.name);
        audit.writes.push({ method: 'POST', name: value.name });
      } else if (request.method === 'DELETE') {
        audit.writes.push({ method: 'DELETE', count: audit.records.length });
        audit.records.length = 0;
      } else audit.reads++;
      response.end(JSON.stringify({ records: audit.records }));
    } else if (request.url === '/') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(HTML);
    } else response.writeHead(404).end();
  });
  return { server, audit };
}
