// 真实 Chrome 对公网 HTTP 实例的门禁复测（5 MB 键入延迟 + 非安全上下文能力）
// 用法：node tools/chrome-public-check.mjs <base-url> <password>
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const BASE = process.argv[2] || 'http://39.105.48.52:8899';
const PASS = process.argv[3] || 'ecs-public-verify-2026';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9333;

const child = spawn(CHROME, [
  '--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`,
  '--no-first-run', '--no-default-browser-check', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitWs() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* 未就绪 */ }
    await sleep(300);
  }
  throw new Error('Chrome DevTools 未就绪');
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map();
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); } }; }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, (m) => (m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)));
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
}

try {
  const wsUrl = await waitWs();
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: BASE + '/' });
  // 公网加载 4.3MB bundle：轮询等待应用就绪（最多 90 s）
  let ready = false;
  for (let i = 0; i < 90; i++) {
    try { ready = await cdp.evaluate(`typeof window.__openDoc === 'function'`); } catch { /* 页面未就绪 */ }
    if (ready) break;
    await sleep(1000);
  }
  if (!ready) throw new Error('应用 bundle 90 s 内未就绪');

  // 登录 + 播种 5MB 文档
  const seed = await cdp.evaluate(`(async () => {
    await fetch('/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: ${JSON.stringify(PASS)} }) }).catch(() => {});
    await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: ${JSON.stringify(PASS)} }) });
    const r = await fetch('/api/docs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ doc_id: 'chrome5', title: 'Chrome 5MB', body: Array(62500).fill('x'.repeat(79)).join('\\n') }) });
    return { created: r.status, secure: window.isSecureContext, clipboard: !!(navigator.clipboard && navigator.clipboard.read) };
  })()`);
  // 登录后重载使 boot 成功（创建编辑器）
  await cdp.send('Page.navigate', { url: BASE + '/' });
  ready = false;
  for (let i = 0; i < 60; i++) {
    try { ready = await cdp.evaluate(`typeof window.__openDoc === 'function' && !document.getElementById('main').hidden`); } catch { /* 未就绪 */ }
    if (ready) break;
    await sleep(1000);
  }
  if (!ready) throw new Error('登录后应用未就绪');
  await sleep(500);
  const t0 = Date.now();
  await cdp.evaluate(`window.__openDoc('chrome5')`);
  const openMs = Date.now() - t0;
  await sleep(800);
  await cdp.evaluate(`window.__lat = []; document.querySelector('.cm-content').focus();`);
  for (const ch of 'abcdefghij') {
    await cdp.send('Input.dispatchKeyEvent', { type: 'char', text: ch });
    await sleep(60);
  }
  await sleep(400);
  const stats = await cdp.evaluate(`window.__latStats()`);
  const result = { browser: 'Chrome headless（本机真实安装）', base: BASE, seed, openMs, stats };
  console.log(JSON.stringify(result, null, 2));
  fs.mkdirSync('experiments/evidence/ecs-public', { recursive: true });
  fs.writeFileSync('experiments/evidence/ecs-public/chrome-public-check.json', JSON.stringify(result, null, 2));
  ws.close();
} finally {
  child.kill();
}
