// 公网端到端自测（真实 Chrome + CDP）：对暂存实例走完整用户旅程
// 用法：node tools/e2e-public.mjs
import { spawn } from 'node:child_process';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://39.105.48.52:8898';
const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--remote-debugging-port=9336', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let wsUrl;
  for (let i = 0; i < 40; i++) {
    try { const l = await (await fetch('http://127.0.0.1:9336/json')).json(); const p = l.find((t) => t.type === 'page'); if (p) { wsUrl = p.webSocketDebuggerUrl; break; } } catch { /* retry */ }
    await sleep(300);
  }
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.onopen = r);
  let id = 0; const pend = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result))); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };

  const out = {};
  // 1) 加载时间（gzip 后）
  const t0 = Date.now();
  await send('Page.enable');
  await send('Page.navigate', { url: BASE + '/' });
  await evaluate(`new Promise(r => { const i = setInterval(() => { if (window.__latStats) { clearInterval(i); r(); } }, 200); setTimeout(() => { clearInterval(i); r(); }, 60000); })`);
  out.loadMs = Date.now() - t0;

  // 2) devlogin + 打开示例文档
  await evaluate(`fetch('/api/devlogin', { method: 'POST' })`);
  await evaluate(`location.reload()`);
  await evaluate(`new Promise(r => { const i = setInterval(() => { if (window.__latStats && !document.getElementById('auth')?.hidden === false) { clearInterval(i); r(); } if (window.__latStats) { clearInterval(i); r(); } }, 200); setTimeout(() => { clearInterval(i); r(); }, 30000); })`);
  await sleep(800);
  out.loggedInMainVisible = await evaluate(`!document.getElementById('main').hidden`);
  const docs = await evaluate(`fetch('/api/docs').then(r => r.json()).then(j => j.docs.length)`);
  out.docsCount = docs;
  await evaluate(`fetch('/api/docs').then(r => r.json()).then(j => window.__openDoc(j.docs[0].doc_id))`);
  await sleep(500);

  // 3) 键入
  await evaluate(`document.querySelector('.cm-content').focus()`);
  for (const ch of '端到端自测abc') { await send('Input.dispatchKeyEvent', { type: 'char', text: ch }); await sleep(60); }
  await sleep(400);
  out.typing = await evaluate(`({ len: window.__getBody().length, stats: window.__latStats() })`);

  // 4) 手动同步
  await evaluate(`document.getElementById('btnSync').click()`);
  await sleep(600);
  out.syncStatus = await evaluate(`document.getElementById('statusChip').title`);

  // 5) 抽屉 + 批量条
  await evaluate(`document.getElementById('btnDocs').click()`);
  await sleep(300);
  out.drawerOpen = await evaluate(`document.getElementById('drawer').classList.contains('open')`);
  await evaluate(`document.getElementById('btnBatch').click()`);
  out.batchBar = await evaluate(`!document.getElementById('batchBar').hidden`);
  await evaluate(`document.getElementById('btnDrawerClose').click()`);

  // 6) 分享
  await evaluate(`document.querySelector('#docMenu > button').click()`);
  await sleep(200);
  await evaluate(`document.querySelector('[data-act="share"]').click()`);
  await sleep(500);
  out.shareStatus = await evaluate(`document.getElementById('statusChip').title`);

  // 7) 导出 Markdown（拦截下载，验证 blob 生成）
  out.exportMd = await evaluate(`(async () => { let ok = false; const orig = URL.createObjectURL; URL.createObjectURL = (b) => { ok = b.size > 0; return orig(b); }; document.querySelector('#docMenu > button').click(); await new Promise(r => setTimeout(r, 150)); document.querySelector('[data-act="export"]').click(); await new Promise(r => setTimeout(r, 300)); URL.createObjectURL = orig; return ok; })()`);

  // 8) 版本历史
  await evaluate(`document.querySelector('#docMenu > button').click()`);
  await sleep(200);
  await evaluate(`document.querySelector('[data-act="versions"]').click()`);
  await sleep(400);
  out.versionsRows = await evaluate(`document.querySelectorAll('#verList button').length`);
  await evaluate(`document.getElementById('verClose').click()`);

  // 9) 帮助/设置/目录/统计
  out.help = await evaluate(`(document.querySelector('#sysMenu > button').click(), new Promise(r => setTimeout(() => { document.querySelector('[data-act="help"]').click(); setTimeout(() => r(!document.getElementById('helpDialog').hidden), 200); }, 150)))`);
  await evaluate(`document.getElementById('helpClose').click()`);
  await evaluate(`document.getElementById('btnToc').click(); document.getElementById('statusChip').click()`);
  out.tocStats = await evaluate(`({ toc: !document.getElementById('tocDrop').hidden, stats: !document.getElementById('statsDrop').hidden })`);

  console.log(JSON.stringify(out, null, 1));
  ws.close(); child.kill(); process.exit(0);
})().catch((e) => { console.error('E2E ERR:', e.message); child.kill(); process.exit(1); });
