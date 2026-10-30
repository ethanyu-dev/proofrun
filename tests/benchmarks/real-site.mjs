import {
  BASIC_INTERACTIONS,
  basicInteractionPage,
} from '../../contracts/dist/benchmark-interactions.js';
import { createServer } from 'node:http';

/** 合成业务站点没有外部请求、账号或真实用户数据；独立真值只通过进程内方法读取。 */
const HEAD =
  '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>本地基础场景</title><style>body{font:16px sans-serif;max-width:720px;margin:40px auto}label{display:block;margin:16px 0}input,button{padding:10px}p{line-height:1.5}</style>';
const FORM =
  '<h1>提交测试资料</h1><form><label>姓名<input name="name" required></label><label>城市<input name="city" required></label><button type="submit">保存资料</button></form><p role="status">尚未提交</p>';
const SCRIPT = `<script>document.querySelector('form').onsubmit=async event=>{event.preventDefault();const data=Object.fromEntries(new FormData(event.target));const response=await fetch(location.pathname+'/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const result=await response.json();document.querySelector('[role=status]').textContent='已保存：'+result.name+' / '+result.city+'；保存次数 '+result.count;};</script>`;
/** 被测业务页刻意包含浏览器原生控件，验证模型操作能力；不复用 Console 产品组件。 */
const CONTROLS =
  '<h1>提交测试资料</h1><form><label>姓名<input name="name" required></label><label>城市<select name="city" required><option value="">请选择城市</option><option value="Shanghai">Shanghai</option><option value="Hangzhou">Hangzhou</option></select></label><label><input type="checkbox" name="consent" required>同意保存</label><button type="submit">保存资料</button></form><p role="status">尚未提交</p>';
const DISCLOSURES =
  '<h1>方案比较</h1><details><summary>基础方案</summary><p>方案编号 BASIC-17；月费 19 元</p></details><details><summary>专业方案</summary><p>方案编号 PRO-29；月费 49 元</p></details>';
/** 详情编号只在新标签载入后写入可见 DOM；主页面不能直接观察到它。 */
const TABS =
  '<main></main><script>document.querySelector("main").innerHTML=location.hash==="#detail"?"<h1>详情页面</h1><p>详情编号 DETAIL-73</p>":"<h1>主页面</h1><p>主编号 MAIN-42</p><a target=\\"_blank\\" href=\\"#detail\\">在新标签打开详情</a>";</script>';

/** 每次只启动一份回环服务，每个场景路径隔离提交账本；任何重复写入均计数。 */
export async function realSite() {
  const writes = new Map();
  const visits = new Map();
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, 'http://localhost').pathname;
      const id = path.split('/')[1];
      if (
        ![
          'form-submit',
          'read-only',
          'invalid-target',
          'unknown-write',
          'context-pressure',
          'browser-controls',
          'browser-tabs',
          'browser-disclosures',
          'network-runtime',
          'network-page-return',
          ...BASIC_INTERACTIONS.map((c) => c.id),
        ].includes(id)
      ) {
        response.writeHead(404).end();
        return;
      }
      if (
        id.startsWith('network-') &&
        path === `/${id}/resource` &&
        request.method === 'GET'
      ) {
        response
          .writeHead(200, {
            'Content-Type': 'text/plain',
            'Cache-Control': 'max-age=73',
          })
          .end('resource');
        return;
      }
      if (request.method === 'POST' && path === `/${id}/save`) {
        let body = '';
        for await (const chunk of request) {
          body += chunk;
          if (body.length > 4096) throw new Error('输入过长');
        }
        const value = JSON.parse(body);
        const entries = writes.get(id) ?? [];
        entries.push(value);
        writes.set(id, entries);
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ ...value, count: entries.length }));
        return;
      }
      if (request.method !== 'GET' || path !== `/${id}`) {
        response.writeHead(404).end();
        return;
      }
      visits.set(id, (visits.get(id) ?? 0) + 1);
      if (id.startsWith('network-')) {
        // 缓存由真实页面 API 创建，网络由真实 fetch 发出；模型与控制面不注入观察字段。
        const caching =
          id === 'network-runtime'
            ? `const cache=await caches.open('bench-cache');for(let i=0;i<24;i++)await cache.put(location.origin+location.pathname+'/cache-'+i,new Response('cached',{status:200}));`
            : '';
        response
          .writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
          })
          .end(
            HEAD +
              '<h1>网络核验</h1><p id="ready">准备中</p><button onclick="document.querySelector(\'#result\').textContent=\'RETURN-73\'">显示核验编号</button><p id="result"></p><section>' +
              '辅助说明，与网络核验无关。'.repeat(350) +
              '</section><script>(async()=>{await fetch(location.pathname+"/resource");' +
              caching +
              'document.querySelector("#ready").textContent="准备完成";})();</script></html>',
          );
        return;
      }
      const interaction = basicInteractionPage(id);
      if (interaction) {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(HEAD + interaction + '</html>');
        return;
      }
      const page =
        id === 'read-only'
          ? '<h1>系统状态</h1><p>当前状态：已就绪</p><p>状态编号：READY-2026</p>'
          : id === 'browser-controls'
            ? CONTROLS
            : id === 'browser-tabs'
              ? TABS
              : id === 'browser-disclosures'
                ? DISCLOSURES
                : FORM;
      const long =
        id === 'context-pressure'
          ? '<section><h2>辅助资料</h2><p>' +
            '这是一段与表单操作无关的辅助说明，保存表单请使用上方控件。'.repeat(
              1600,
            ) +
            '</p></section>'
          : '';
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.setHeader('Cache-Control', 'no-store');
      response.end(
        HEAD +
          page +
          long +
          (['read-only', 'browser-tabs', 'browser-disclosures'].includes(id)
            ? ''
            : SCRIPT) +
          '</html>',
      );
    } catch {
      response.writeHead(400).end('invalid request');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    /** 不经页面或模型解释，直接读取本次服务实际收到的写入与访问事实。 */
    facts(id) {
      return {
        writes: structuredClone(writes.get(id) ?? []),
        visits: visits.get(id) ?? 0,
      };
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
