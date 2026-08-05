// 真实浏览器轮驱动：以 CDP 驱动本机 Edge（headless）执行 E7/E8/E9
// 用法：先启动本地静态服务（python -m http.server 8123），再运行本脚本
// 零第三方依赖：Node 24 内置 fetch 与 WebSocket
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeResult } from '../tools/lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORK = path.resolve(HERE, '../work');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9222;
const URL_ = 'http://127.0.0.1:8123/experiments/browser/harness.html';
const TRIAL = 'REAL';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitPageWs() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* 未就绪 */ }
    await sleep(300);
  }
  throw new Error('无法连接 Edge DevTools');
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map();
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); } };
  }
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
  async typeChar(ch) {
    await this.send('Input.dispatchKeyEvent', { type: 'char', text: ch });
  }
}

async function latencyFor(cdp, samplePath, n) {
  await cdp.evaluate(`H.loadSample('${samplePath}').then(() => { H.caretToEnd(); document.getElementById('editor').focus(); })`);
  await sleep(200);
  for (let i = 0; i < n; i++) { await cdp.typeChar('x'); await sleep(40); }
  await sleep(400);
  return cdp.evaluate(`(() => { const m = H.metrics(); return { bytes: m.loaded.bytes, n: m.latencyCount, p50: m.latencyP50ms, p95: m.latencyP95ms, max: m.latencyMaxMs, saves: m.saves, saveErrors: m.saveErrors, lastSaveMs: m.lastSaveMs }; })()`);
}

async function main() {
  fs.mkdirSync(WORK, { recursive: true });
  const profile = path.join(WORK, 'edge-profile');
  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', URL_,
  ], { stdio: 'ignore' });

  try {
    const wsUrl = await waitPageWs();
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const cdp = new Cdp(ws);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await sleep(500);

    const env = await cdp.evaluate('({ ua: navigator.userAgent, secure: window.isSecureContext })');
    await cdp.evaluate('H.wipe()');

    // E7：1/5/10 MB 键入延迟（CDP char 事件为可信输入）
    const mb1 = await latencyFor(cdp, '/experiments/work/samples/S1/s1-1mb.md', 30);
    const mb5 = await latencyFor(cdp, '/experiments/work/samples/S1/s1-5mb.md', 30);
    const mb10 = await latencyFor(cdp, '/experiments/work/samples/S1/s1-10mb.md', 30);

    // E8：保存 → 重载 → 恢复哈希核对 → 断网续编
    await cdp.evaluate(`H.clearEditor(); document.getElementById('editor').value = '# E8 EDGE\\n固定正文 GLMAKE-E8-EDGE。'; H.saveNow()`);
    await sleep(600);
    const savedHash = await cdp.evaluate(`crypto.subtle.digest('SHA-256', new TextEncoder().encode(document.getElementById('editor').value)).then(b => Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, '0')).join(''))`);
    await cdp.send('Page.reload', {});
    await sleep(800);
    const after = await cdp.evaluate(`crypto.subtle.digest('SHA-256', new TextEncoder().encode(document.getElementById('editor').value)).then(b => Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, '0')).join(''))`);
    const offline = await cdp.evaluate('H.syncProbe()');

    // E9：文本与图片粘贴
    const paste = await cdp.evaluate(`(async () => {
      const ed = document.getElementById('editor'); ed.focus();
      const dt1 = new DataTransfer(); dt1.setData('text/plain', 'EDGE 粘贴文本');
      ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt1, bubbles: true, cancelable: true }));
      const bin = atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==');
      const arr = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const dt2 = new DataTransfer(); dt2.items.add(new File([arr], 'e.png', { type: 'image/png' }));
      ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt2, bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 400));
      const m = H.metrics();
      return { text: m.pasteTextCount, image: m.pasteImageCount, errors: m.pasteErrors };
    })()`);

    const result = {
      browser: 'Microsoft Edge（真实安装，headless）',
      env,
      E7: { mb1, mb5, mb10 },
      E8: { savedHash, restoreHashMatches: savedHash === after, offline },
      E9: paste,
      pass: mb1.p95 <= 50 && mb5.p95 <= 100 && mb10.p95 <= 200
        && savedHash === after && offline.syncFailed && offline.editAfterOffline.savedAfterOffline
        && paste.text === 1 && paste.image === 1 && paste.errors === 0,
      limitations: ['headless Edge；正式门禁仍需有界面环境与人工剪贴板复核', 'Firefox 未安装，Safari 需 macOS/真机，属外部阻塞'],
    };
    console.log(JSON.stringify(result, null, 2));
    writeResult(TRIAL, result);
    ws.close();
  } finally {
    child.kill();
  }
}

main().catch((e) => { console.error('REAL 轮失败：', e); process.exit(1); });
