// GLMake 前端 M2：CodeMirror 6 虚拟化编辑器 + 完整方言预览 + 条件自动同步 + 四路径冲突处理
import { basicSetup, EditorView } from 'codemirror';
import { EditorState, Compartment } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import katex from 'katex';
import mermaid from 'mermaid';

mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral' });

// 旧 HTML 缓存自愈：若新版元素缺失（浏览器缓存了旧页面），带参强刷一次拉取 no-store 新 HTML
if (!document.getElementById('btnImage') && !sessionStorage.getItem('glmake-htmlcb')) {
  sessionStorage.setItem('glmake-htmlcb', '1');
  location.replace('/?cb=' + Date.now());
}
document.getElementById('boot-splash')?.remove();

const $ = (s) => document.querySelector(s);
const api = async (p, opts = {}) => {
  const r = await fetch(p, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || String(r.status)), { status: r.status, body: j });
  return j;
};

const settings = Object.assign({ theme: 'system', fontSize: 14, autoSync: false }, JSON.parse(localStorage.getItem('glmake-settings') || '{}'));
function saveSettings() { localStorage.setItem('glmake-settings', JSON.stringify(settings)); applyTheme(); applyFont(); }
function applyTheme() {
  const dark = settings.theme === 'dark' || (settings.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  if (view) view.dispatch({ effects: [themeCompartment.reconfigure(dark ? darkTheme : [])] });
}
function applyFont() { document.documentElement.style.setProperty('--editor-font-size', settings.fontSize + 'px'); }

// ---------- 状态 ----------
let view = null;
let current = null;            // {doc_id, revision, title}
const dirty = new Map();       // docId -> {body, title, base}
let lastSyncCheck = 0;
const AUTO_INTERVAL = 10 * 60 * 1000; // 官网基线：每 10 分钟

// ---------- 编辑器 ----------
const themeCompartment = new Compartment();
const langCompartment = new Compartment();
// 门禁证据（2026-08-06）：CM6+markdown 解析在 5 MB 首载 >15 s，
// 故 >1 MB 文档降级为纯文本虚拟编辑（保留输入响应），预览 >2 MB 节流收敛。
const darkTheme = EditorView.theme({ '&': { background: 'var(--editor-bg)', color: 'var(--editor-text)' }, '.cm-content': { caretColor: '#fff' } }, { dark: true });

function createEditor() {
  if (view) { try { view.destroy(); } catch { /* 忽略 */ } }
  $('#editorHost').innerHTML = '';
  view = new EditorView({
    parent: $('#editorHost'),
    state: EditorState.create({
      doc: '',
      extensions: [
        basicSetup, langCompartment.of([]), themeCompartment.of([]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            if (suppressEdit) return;
            if (pendingKeyT !== null) { window.__lat.push(performance.now() - pendingKeyT); pendingKeyT = null; }
            onEdit();
          }
        }),
      ],
    }),
  });
  // 键入延迟测量钩子（可信 beforeinput → 视图更新）
  window.__lat = [];
  view.dom.addEventListener('beforeinput', (e) => { if (e.isTrusted) pendingKeyT = performance.now(); });
  view.dom.addEventListener('keydown', (e) => { if (e.isTrusted && e.key.length === 1) pendingKeyT = performance.now(); });
}
const getBody = () => view.state.doc.toString();
let suppressEdit = false;
function setBody(text) { suppressEdit = true; view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }); suppressEdit = false; }
let pendingKeyT = null;
// 开发/验证工具：以 API 文档内容载入编辑器（供门禁复测脚本使用）
window.__openDoc = async (id) => { await openDoc(id); };
window.__getBody = () => getBody();
window.__latStats = () => { const l = [...window.__lat].sort((a, b) => a - b); const q = (p) => l.length ? l[Math.min(l.length - 1, Math.floor(p * l.length))] : null; return { n: l.length, p50: q(0.5), p95: q(0.95), max: l[l.length - 1] }; };

let previewTimer = null, saveTimer = null;
function onEdit() {
  const big = getBody().length > 2_000_000;
  clearTimeout(previewTimer);
  previewTimer = setTimeout(renderPreview, big ? 1500 : 200);
  if (big) setStatus('大文档：预览节流中，稍后收敛');
  clearTimeout(saveTimer); saveTimer = setTimeout(() => { if (mode === 'local') { saveLocalDoc(); } else { markDirty(); if (!big) setStatus('本地已保存，待同步'); } }, 500);
}
function markDirty() {
  if (!current) return;
  dirty.set(current.doc_id, { body: getBody(), title: current.title, base: current.revision });
  localStorage.setItem('glmake-pending', JSON.stringify([...dirty.entries()]));
}
function restorePending() {
  try { for (const [k, v] of JSON.parse(localStorage.getItem('glmake-pending') || '[]')) dirty.set(k, v); } catch { /* 忽略 */ }
}

// ---------- 未登录本地模式（立项 §0：未登录可本地写作） ----------
let mode = 'server';
function idbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('glmake-local', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('docs', { keyPath: 'id' }); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function idbAllDocs() {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const q = db.transaction('docs', 'readonly').objectStore('docs').getAll();
    q.onsuccess = () => res((q.result || []).sort((a, b) => (b.updated || 0) - (a.updated || 0)));
    q.onerror = () => rej(q.error);
  });
}
async function idbPutDoc(d) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction('docs', 'readwrite');
    tx.objectStore('docs').put(d);
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
  });
}
async function saveLocalDoc() {
  if (!current) return;
  await idbPutDoc({ id: current.doc_id, title: current.title, body: getBody(), updated: Date.now() });
  setStatus('本地已保存（未登录，仅存此浏览器）');
}

// ---------- 同步引擎 ----------
function setStatus(t) { $('#statusChip').title = t; $('#statusChip').textContent = t; clearTimeout(setStatus._t); setStatus._t = setTimeout(() => { $('#statusChip').textContent = chipWords(); }, 3000); }
function chipWords() { const b = getBody(); return ((b.match(/[A-Za-z]+/g) || []).length + (b.match(/[\u4e00-\u9fa5]/g) || []).length) + ' 字'; }
async function syncNow(reason) {
  if (mode === 'local') { $('#auth').hidden = false; $('#authTitle').textContent = '登录'; setStatus('登录后即可同步到服务器'); return; }
  if (dirty.size === 0) { setStatus(`同步检查（${reason}）：无更新，未产生写入`); lastSyncCheck = Date.now(); return; }
  let ok = 0, conflicts = 0;
  for (const [docId, d] of [...dirty.entries()]) {
    try {
      const r = await api(`/api/docs/${docId}`, { method: 'PUT', body: JSON.stringify({ base_revision: d.base, body: d.body, title: d.title, request_id: crypto.randomUUID() }) });
      dirty.delete(docId); ok++;
      if (current && current.doc_id === docId) current.revision = r.revision;
    } catch (e) {
      if (e.status === 409) { conflicts++; openConflict(docId, d); }
      else { setStatus('同步失败：' + e.message); }
    }
  }
  localStorage.setItem('glmake-pending', JSON.stringify([...dirty.entries()]));
  lastSyncCheck = Date.now();
  setStatus(`同步（${reason}）：成功 ${ok}，冲突 ${conflicts}，待处理 ${dirty.size}`);
  refreshList();
}
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); syncNow('手动 Ctrl+S'); }
});
window.addEventListener('online', () => { syncNow('恢复联网补做'); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && settings.autoSync && Date.now() - lastSyncCheck >= AUTO_INTERVAL) syncNow('回到前台补做');
});
setInterval(() => {
  if (!settings.autoSync) return;
  autoTick('自动 10 分钟');
}, AUTO_INTERVAL);
function autoTick(reason) {
  // 条件自动同步：仅当存在待同步更新时写入；无更新零写入
  if (dirty.size > 0) syncNow(reason);
  else { lastSyncCheck = Date.now(); setStatus(`自动同步检查：无更新，未产生写入`); }
}
window.__autoTick = autoTick;

// ---------- 冲突四路径 ----------
async function openConflict(docId, local) {
  const server = await api('/api/docs/' + docId);
  const dlg = $('#conflict');
  dlg.hidden = false;
  $('#cfTitle').textContent = `冲突：${server.title}（服务器修订 ${server.revision}，你的基础修订 ${local.base}）`;
  $('#cfLocal').textContent = local.body;
  $('#cfServer').textContent = server.body;
  $('#conflict').dataset.doc = docId;
  $('#conflict').dataset.serverRev = server.revision;
  $('#conflict').dataset.localBody = local.body;
}
$('#cfUseLocal').onclick = async () => {
  const dlg = $('#conflict'); const docId = dlg.dataset.doc;
  const r = await api(`/api/docs/${docId}`, { method: 'PUT', body: JSON.stringify({ base_revision: Number(dlg.dataset.serverRev), body: dlg.dataset.localBody, request_id: crypto.randomUUID() }) });
  dirty.delete(docId); localStorage.setItem('glmake-pending', JSON.stringify([...dirty.entries()]));
  if (current && current.doc_id === docId) { current.revision = r.revision; }
  dlg.hidden = true; setStatus('已使用本地版（云端旧版保留在历史版本）');
};
$('#cfUseServer').onclick = () => {
  const dlg = $('#conflict'); const docId = dlg.dataset.doc;
  setBody($('#cfServer').textContent);
  dirty.delete(docId); localStorage.setItem('glmake-pending', JSON.stringify([...dirty.entries()]));
  if (current && current.doc_id === docId) current.revision = Number(dlg.dataset.serverRev);
  dlg.hidden = true; setStatus('已使用云端版'); renderPreview();
};
$('#cfSaveBoth').onclick = async () => {
  const dlg = $('#conflict'); const docId = dlg.dataset.doc;
  await api('/api/docs', { method: 'POST', body: JSON.stringify({ title: '冲突另存（本地版）', body: dlg.dataset.localBody, request_id: crypto.randomUUID() }) });
  setBody($('#cfServer').textContent);
  dirty.delete(docId); localStorage.setItem('glmake-pending', JSON.stringify([...dirty.entries()]));
  dlg.hidden = true; setStatus('本地版已另存为新文档'); refreshList();
};
$('#cfClose').onclick = () => { $('#conflict').hidden = true; };

// ---------- 预览（完整方言） ----------
function esc(s) { return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\$([^$]+)\$/g, (m, t) => { try { return katex.renderToString(t, { throwOnError: false }); } catch { return m; } })
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2" style="max-width:100%">')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" rel="noopener">$1</a>');
}
let mermaidSeq = 0;
let previewRun = 0;
async function renderPreview() {
  const run = ++previewRun;
  const md = getBody();
  const lines = md.split('\n');
  const host = $('#previewPane');
  host.innerHTML = '';
  let buf = []; let inCode = false; let codeLang = ''; let codeBuf = [];
  let inMath = false; let mathBuf = [];
  let chunk = '';
  const flush = () => { if (buf.length) { chunk += '<p>' + buf.map(inline).join('<br>') + '</p>'; buf = []; } };
  const emit = () => { if (chunk) { host.insertAdjacentHTML('beforeend', chunk); chunk = ''; } };
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (inMath) { mathBuf.push(line); if (line.includes('\\]')) { const t = mathBuf.join('\n').replace(/\\\[|\\\]/g, ''); try { chunk += '<div>' + katex.renderToString(t, { throwOnError: false, displayMode: true }) + '</div>'; } catch { chunk += '<pre>' + esc(t) + '</pre>'; } inMath = false; mathBuf = []; } continue; }
    if (inCode) {
      if (line.startsWith('```')) {
        const code = codeBuf.join('\n');
        if (codeLang === 'mermaid') { const id = 'mm' + (++mermaidSeq); chunk += `<div class="mermaid" data-mm="${id}"></div>`; scheduleMermaid(id, code); }
        else chunk += '<pre><code>' + esc(code) + '</code></pre>';
        inCode = false; codeBuf = [];
      } else codeBuf.push(line);
      continue;
    }
    if (line.startsWith('```')) { flush(); inCode = true; codeLang = line.slice(3).trim(); continue; }
    if (line.startsWith('\\[')) { flush(); inMath = true; mathBuf = [line]; continue; }
    const nbm = line.match(/^@\(([^)]*)\)\[([^\]]*)\]\s*$/);
    if (nbm) { flush(); chunk += '<div>' + ['<span class="nb-chip">' + esc(nbm[1]) + '</span>'].concat(nbm[2].split(/[|,]/).filter(Boolean).map((t) => '<span class="nb-chip">' + esc(t.trim()) + '</span>')).join('') + '</div>'; continue; }
    const h = line.match(/^(#{1,6})\s+(.*)/);
    if (h) { flush(); chunk += `<h${h[1].length}>` + inline(h[2]) + `</h${h[1].length}>`; continue; }
    if (/^>\s?/.test(line)) { flush(); chunk += '<blockquote>' + inline(line.replace(/^>\s?/, '')) + '</blockquote>'; continue; }
    if (/^[-*] \[( |x)\] /.test(line)) { flush(); chunk += `<div><input type="checkbox" disabled ${line[3] === 'x' ? 'checked' : ''}> ${inline(line.slice(6))}</div>`; continue; }
    if (/^[-*] /.test(line)) { flush(); chunk += '<div>• ' + inline(line.slice(2)) + '</div>'; continue; }
    if (/^\d+\. /.test(line)) { flush(); chunk += '<div>' + inline(line) + '</div>'; continue; }
    if (/^\|.*\|/.test(line)) {
      flush();
      const rows = [line];
      while (li + 1 < lines.length && /^\|.*\|/.test(lines[li + 1])) { rows.push(lines[li + 1]); li++; }
      const cells = (r) => r.split('|').slice(1, -1).map((c) => c.trim());
      let t = '<table>';
      rows.forEach((r, idx) => {
        if (idx === 1 && /^[\s|:-]+$/.test(r)) return;
        const tag = idx === 0 ? 'th' : 'td';
        t += '<tr>' + cells(r).map((c) => `<${tag}>` + inline(c) + `</${tag}>`).join('') + '</tr>';
      });
      chunk += t + '</table>';
      continue;
    }
    if (line.trim() === '') { flush(); continue; }
    buf.push(line);
    if (li % 4000 === 3999) { flush(); emit(); if (run !== previewRun) return; await new Promise((r) => setTimeout(r, 0)); }
  }
  flush(); emit();
  if (run === previewRun) processMermaid();
}
const mermaidQueue = [];
function scheduleMermaid(id, code) { mermaidQueue.push([id, code]); }
async function processMermaid() {
  while (mermaidQueue.length) {
    const [id, code] = mermaidQueue.shift();
    const el = document.querySelector(`[data-mm="${id}"]`);
    if (!el) continue;
    try {
      const { svg } = await Promise.race([
        mermaid.render('mmr' + id, code),
        new Promise((_, rej) => setTimeout(() => rej(new Error('渲染超时')), 5000)),
      ]);
      el.innerHTML = svg;
    } catch (e) {
      el.innerHTML = '<pre>[流程图/时序图渲染失败：' + esc(String(e.message || e)) + ']</pre>';
    }
  }
}

// ---------- 版本历史 ----------
async function openVersions() {
  if (!current) return;
  const j = await api(`/api/docs/${current.doc_id}/versions`);
  const box = $('#verList'); box.innerHTML = '';
  for (const v of j.versions) {
    const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:8px;align-items:center;padding:4px 0';
    const t = document.createElement('span'); t.textContent = `修订 ${v.revision} · ${new Date(v.created_ms).toLocaleString()} · ${v.size} B`; t.style.flex = '1';
    const b = document.createElement('button'); b.textContent = '恢复此版本';
    b.onclick = async () => { await api(`/api/docs/${current.doc_id}/versions/${v.revision}/restore`, { method: 'POST' }); $('#versions').hidden = true; await openDoc(current.doc_id); setStatus(`已恢复修订 ${v.revision} 为新版本`); };
    row.append(t, b); box.appendChild(row);
  }
  $('#versions').hidden = false;
}
$('#verClose').onclick = () => { $('#versions').hidden = true; };

// ---------- 导出 ----------
function download(name, content, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name; a.click(); URL.revokeObjectURL(a.href);
}
function exportMarkdown() { if (current) download((current.title || 'doc') + '.md', getBody(), 'text/markdown;charset=utf-8'); }
function exportHtml() {
  if (!current) return;
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${current.title}</title></head><body>` + $('#previewPane').innerHTML + '</body></html>';
  download((current.title || 'doc') + '.html', html, 'text/html;charset=utf-8');
}
function exportPdf() {
  if (!current) return;
  const w = window.open('', '_blank');
  w.document.write(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${current.title}</title><link rel="stylesheet" href="/vendor/katex.min.css"></head><body>` + $('#previewPane').innerHTML + '<scr' + 'ipt>setTimeout(()=>window.print(),300)</script></body></html>');
  w.document.close();
}

// ---------- 图片粘贴上传 ----------
function bindPaste() {
  view.dom.addEventListener('paste', async (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const it of items) {
      if (it.type && it.type.startsWith('image/')) {
        e.preventDefault();
        const file = it.getAsFile();
        const buf = await file.arrayBuffer();
        const up = await fetch('/api/attachments', { method: 'POST', body: buf, headers: { 'x-glmake-name': file.name || 'pasted.png', 'x-glmake-mime': file.type } });
        if (!up.ok) { setStatus('图片上传失败：' + (await up.json()).error); return; }
        const j = await up.json();
        const md = `![${file.name || '粘贴图片'}](/api/attachments/${j.hash}?inline=1)`;
        view.dispatch({ changes: { from: view.state.selection.main.from, insert: md } });
        setStatus('图片已上传并插入');
        return;
      }
    }
  });
}

// ---------- 文档管理 ----------
async function refreshList() {
  const docs = mode === 'local' ? (await idbAllDocs()).map((d) => ({ doc_id: d.id, title: d.title })) : (await api('/api/docs')).docs;
  const list = $('#doclist'); list.innerHTML = '';
  for (const d of docs) {
    const b = document.createElement('button');
    b.textContent = d.title + (dirty.has(d.doc_id) ? ' ●' : '');
    if (batchMode) {
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = sel.has(d.doc_id); cb.style.marginRight = '8px';
      cb.onclick = (e) => { e.stopPropagation(); cb.checked ? sel.add(d.doc_id) : sel.delete(d.doc_id); };
      b.prepend(cb);
      b.onclick = () => { cb.checked = !cb.checked; cb.checked ? sel.add(d.doc_id) : sel.delete(d.doc_id); };
    } else {
      if (current && current.doc_id === d.doc_id) b.classList.add('active');
      b.onclick = () => openDoc(d.doc_id);
    }
    list.appendChild(b);
  }
}
async function openDoc(id) {
  if (mode === 'local') {
    const docs = await idbAllDocs();
    const d = docs.find((x) => x.id === id) || docs[0];
    current = { doc_id: d.id, revision: 0, title: d.title, local: true };
    view.dispatch({ effects: [langCompartment.reconfigure(d.body.length <= 1_000_000 ? markdown() : [])] });
    setBody(d.body); renderPreview(); refreshList();
    setStatus(`已打开：${d.title}（本地模式）`);
    return;
  }
  const d = await api('/api/docs/' + id);
  current = { doc_id: id, revision: d.revision, title: d.title };
  $('#docTitle').textContent = d.title;
  const pend = dirty.get(id);
  const body = pend ? pend.body : d.body;
  view.dispatch({ effects: [langCompartment.reconfigure(body.length <= 1_000_000 ? markdown() : [])] });
  setBody(body);
  if (body.length > 2_000_000) { setStatus('大文档：预览将于空闲时收敛'); setTimeout(renderPreview, 500); }
  else renderPreview();
  refreshList();
  setStatus(`已打开：${d.title}（修订 ${d.revision}${pend ? '，含未同步本地修改' : ''}${body.length > 1_000_000 ? '；大文档模式：语法高亮关闭' : ''}）`);
}
$('#btnNew').onclick = async () => {
  if (mode === 'local') {
    const d = { id: 'local-' + Date.now().toString(36), title: '无标题', body: '# 无标题\n', updated: Date.now() };
    await idbPutDoc(d); await refreshList(); openDoc(d.id); return;
  }
  const r = await api('/api/docs', { method: 'POST', body: JSON.stringify({ title: '无标题', body: '# 无标题\n', notebook: '默认笔记本', request_id: crypto.randomUUID() }) });
  await refreshList(); openDoc(r.doc_id);
};
$('#search').addEventListener('input', async () => {
  const q = $('#search').value;
  if (q.length < 3) return refreshList();
  const r = await api('/api/search?q=' + encodeURIComponent(q));
  const list = $('#doclist'); list.innerHTML = '';
  for (const d of r.results) {
    const b = document.createElement('button'); b.textContent = d.title; b.onclick = () => openDoc(d.doc_id);
    list.appendChild(b);
  }
});

// ---------- 系统菜单 ----------
document.querySelectorAll('.menu > button').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); b.parentElement.classList.toggle('open'); }));
document.addEventListener('click', () => document.querySelectorAll('.menu.open').forEach((m) => m.classList.remove('open')));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.querySelectorAll('.menu.open').forEach((m) => m.classList.remove('open')); });
$('#sysMenu').addEventListener('click', async (e) => {
  const act = e.target.dataset.act; if (!act) return;
  if (act === 'theme') { settings.theme = settings.theme === 'light' ? 'dark' : settings.theme === 'dark' ? 'system' : 'light'; saveSettings(); }
  if (act === 'font-up') { settings.fontSize = Math.min(20, settings.fontSize + 1); saveSettings(); }
  if (act === 'font-down') { settings.fontSize = Math.max(12, settings.fontSize - 1); saveSettings(); }
  if (act === 'autosync') { settings.autoSync = !settings.autoSync; saveSettings(); setStatus(settings.autoSync ? '自动同步已开启（每 10 分钟，仅有更新时写入）' : '自动同步已关闭'); }
  if (act === 'settings') openSettings();
  if (act === 'login') { $('#auth').hidden = false; $('#authTitle').textContent = '登录'; }
  if (act === 'help') { $('#helpDialog').hidden = false; }
  if (act === 'export') { exportMarkdown(); }
  if (act === 'export-html') { exportHtml(); }
  if (act === 'export-pdf') { exportPdf(); }
  if (act === 'export-all') { await api('/api/export', { method: 'POST' }); setStatus('全量导出完成'); }
  if (act === 'logout') { await api('/api/logout', { method: 'POST' }); location.reload(); }
  if (act === 'logoutall') { await api('/api/logout-all', { method: 'POST' }); location.reload(); }
});

// ---------- 工具栏直接按钮与文档抽屉 ----------
$('#btnDocs').onclick = () => { $('#drawer').classList.toggle('open'); refreshList(); };
$('#btnDrawerClose').onclick = () => $('#drawer').classList.remove('open');
$('#btnSync').onclick = () => syncNow('手动');
$('#btnImage').onclick = () => {
  const md = '![描述](图片地址)';
  view.dispatch({ changes: { from: view.state.selection.main.from, insert: md } });
  setStatus('已插入图片语法，可替换为附件地址');
};
$('#btnFull').onclick = () => {
  document.body.classList.toggle('full-editor');
  $('#btnFull').textContent = document.body.classList.contains('full-editor') ? '❐' : '⛶';
};
$('#btnFull').textContent = '⛶';
let trashMode = false;
$('#btnTrash').onclick = async () => {
  trashMode = !trashMode;
  const list = $('#doclist'); list.innerHTML = '';
  if (trashMode) {
    const j = await api('/api/docs?deleted=1');
    for (const d of j.docs) {
      const b = document.createElement('button'); b.textContent = '🗑 ' + d.title;
      b.onclick = async () => { await api(`/api/docs/${d.doc_id}/restore`, { method: 'POST' }); $('#btnTrash').onclick(); };
      list.appendChild(b);
    }
    if (!j.docs.length) list.innerHTML = '<p style="padding:12px;color:var(--muted)">回收站为空</p>';
  } else refreshList();
};

// ---------- 文档菜单（马克飞象式：恢复/删除/导出/分享） ----------
$('#docMenu').addEventListener('click', async (e) => {
  const act = e.target.dataset.act; if (!act) return;
  if (act === 'versions') openVersions();
  if (act === 'share') {
    if (current) { const r = await api('/api/shares', { method: 'POST', body: JSON.stringify({ doc_id: current.doc_id }) }); setStatus('分享链接：' + location.origin + r.url + '（可撤销）'); }
  }
  if (act === 'export') exportMarkdown();
  if (act === 'export-html') exportHtml();
  if (act === 'export-pdf') exportPdf();
  if (act === 'trash') { $('#drawer').classList.add('open'); if (!trashMode) $('#btnTrash').onclick(); }
  if (act === 'purge' && current && confirm('永久删除当前文档？不可恢复。')) {
    await api(`/api/docs/${current.doc_id}/purge`, { method: 'POST' });
    current = null; $('#docTitle').textContent = ''; setBody(''); refreshList(); setStatus('已永久删除');
  }
});

let batchMode = false; const sel = new Set();

// ---------- 统计 / 目录 / 帮助 / 设置 / 批量（马克飞象式细节） ----------
function updateStats() {
  const b = getBody();
  $('#stChars').textContent = b.length;
  $('#stWords').textContent = (b.match(/[A-Za-z]+/g) || []).length + (b.match(/[\u4e00-\u9fa5]/g) || []).length;
  $('#stParas').textContent = b.split(/\n{2,}/).filter((p) => p.trim()).length;
}
$('#statusChip').addEventListener('click', () => { updateStats(); $('#statsDrop').hidden = !$('#statsDrop').hidden; });
function updateToc() {
  const list = $('#tocList'); list.innerHTML = '';
  const heads = [];
  getBody().split('\n').forEach((ln) => { const m = ln.match(/^(#{1,4})\s+(.*)/); if (m) heads.push({ lv: m[1].length, t: m[2] }); });
  heads.forEach((h, i) => {
    const b = document.createElement('button');
    b.style.display = 'block'; b.style.paddingLeft = (h.lv - 1) * 10 + 'px'; b.textContent = h.t;
    b.onclick = () => { const els = document.querySelectorAll('#previewPane h1, #previewPane h2, #previewPane h3, #previewPane h4'); if (els[i]) els[i].scrollIntoView(); };
    list.appendChild(b);
  });
  if (!heads.length) list.innerHTML = '<span style="opacity:.6">（无标题）</span>';
}
$('#btnToc').onclick = () => { updateToc(); $('#tocDrop').hidden = !$('#tocDrop').hidden; };

document.addEventListener('keydown', (e) => {
  const c = e.ctrlKey || e.metaKey; if (!c) return;
  const k = e.key.toLowerCase();
  if (k === 'o') { e.preventDefault(); $('#drawer').classList.toggle('open'); refreshList(); }
  else if (k === '/') { e.preventDefault(); $('#helpDialog').hidden = !$('#helpDialog').hidden; }
  else if (e.key === 'Enter' && !e.altKey) { e.preventDefault(); $('#btnFull').click(); }
  else if (e.altKey && k === 'n') { e.preventDefault(); $('#btnNew').click(); }
  else if (k === 'm') { e.preventDefault(); $('#sysMenu').classList.toggle('open'); }
});
$('#helpClose').onclick = () => { $('#helpDialog').hidden = true; };

function applyEditorPrefs() {
  const map = { dark: ['#202124', '#e8eaed'], warm: ['#3b352c', '#e5b567'], light: ['#fafafa', '#222222'] };
  const t = settings.editorTheme || 'warm';
  document.documentElement.style.setProperty('--editor-bg', map[t][0]);
  document.documentElement.style.setProperty('--editor-text', map[t][1]);
  const fam = { default: '', pt: '"PT Sans", "Microsoft YaHei", sans-serif', mono: 'Consolas, "Courier New", monospace' }[settings.fontFamily || 'pt'];
  $('#editorHost').style.fontFamily = fam;
  let tag = document.getElementById('customCssTag');
  if (!tag) { tag = document.createElement('style'); tag.id = 'customCssTag'; document.head.appendChild(tag); }
  tag.textContent = settings.customCss || '';
}
function openSettings() {
  $('#setTheme').value = settings.theme; $('#setEditorTheme').value = settings.editorTheme || 'dark';
  $('#setFontSize').value = settings.fontSize; $('#setFontFamily').value = settings.fontFamily || 'default';
  $('#setAutoSync').checked = !!settings.autoSync; $('#setCustomCss').value = settings.customCss || '';
  $('#settingsDialog').hidden = false;
}
$('#setClose').onclick = () => {
  settings.theme = $('#setTheme').value; settings.editorTheme = $('#setEditorTheme').value;
  settings.fontSize = Math.max(12, Math.min(24, Number($('#setFontSize').value) || 14));
  settings.fontFamily = $('#setFontFamily').value; settings.autoSync = $('#setAutoSync').checked; settings.customCss = $('#setCustomCss').value;
  saveSettings(); applyEditorPrefs();
  $('#settingsDialog').hidden = true;
};

$('#btnBatch').onclick = () => { batchMode = !batchMode; sel.clear(); $('#batchBar').hidden = !batchMode; refreshList(); };
$('#bSelAll').onclick = async () => { const j = await api('/api/docs'); j.docs.forEach((d) => sel.add(d.doc_id)); refreshList(); };
$('#bUnsel').onclick = () => { sel.clear(); refreshList(); };
$('#bMove').onclick = async () => {
  const nb = $('#bNotebook').value.trim(); if (!nb || !sel.size) return;
  for (const id of sel) await api(`/api/docs/${id}/move`, { method: 'POST', body: JSON.stringify({ notebook: nb }) });
  sel.clear(); refreshList(); setStatus(`已移动 ${sel.size || ''} 篇到 ${nb}`);
};
$('#bDel').onclick = async () => {
  if (!sel.size || !confirm(`删除所选 ${sel.size} 篇到回收站？`)) return;
  for (const id of sel) await api(`/api/docs/${id}/trash`, { method: 'POST' });
  sel.clear(); refreshList(); setStatus('已删除到回收站');
};
$('#bCreateNb').onclick = async () => {
  const nb = $('#bNewNb').value.trim(); if (!nb) return;
  await api('/api/docs', { method: 'POST', body: JSON.stringify({ title: '（占位）', body: '', notebook: nb, request_id: crypto.randomUUID() }) });
  $('#bNewNb').value = ''; refreshList(); setStatus(`笔记本 ${nb} 已创建`);
};

// ---------- 认证 ----------
async function boot() {
  try {
    if (location.hash === '#devlogin') { await fetch('/api/devlogin', { method: 'POST' }).catch(() => {}); }
    const h = await api('/api/health');
    if (!h.initialized) {
      $('#auth').hidden = false; $('#main').hidden = true;
      $('#authTitle').textContent = '首次使用：创建所有者账户';
      const m = $('#authMsg'); m.style.color = 'var(--muted)';
      m.textContent = '实例尚未初始化：输入用户名与≥8 位密码即可创建唯一所有者账户；恢复码仅展示一次，请立即抄存。';
      return;
    }
    await api('/api/docs');
    mode = 'server';
    $('#auth').hidden = true; $('#main').hidden = false;
    createEditor(); applyTheme(); applyFont(); applyEditorPrefs(); restorePending(); refreshList(); bindPaste();
    if (location.hash === '#devlogin') { const j = await api('/api/docs'); if (j.docs && j.docs[0]) await openDoc(j.docs[0].doc_id); }
    setStatus(settings.autoSync ? '自动同步已开启' : '就绪（Ctrl+S 手动同步）');
  } catch (e) {
    // 未登录 → 本地模式（不阻断写作）
    mode = 'local';
    $('#auth').hidden = true; $('#main').hidden = false;
    createEditor(); applyTheme(); applyFont(); applyEditorPrefs(); bindPaste();
    const docs = await idbAllDocs();
    if (!docs.length) {
      const d = { id: 'local-welcome', title: '欢迎使用 GLMake', body: '# 欢迎使用 GLMake\n\n本地模式：内容保存在此浏览器。\n登录后（☰ 菜单 → 登录）即可同步到服务器。', updated: Date.now() };
      await idbPutDoc(d);
    }
    await openDoc((await idbAllDocs())[0].id);
    setStatus('本地模式（未登录）：可正常写作，登录后同步');
  }
}
$('#authToggleRecover').onclick = () => {
  const inp = $('#authRecover');
  inp.hidden = !inp.hidden;
  $('#authToggleRecover').textContent = inp.hidden ? '忘记密码？使用恢复码' : '返回密码登录';
};
$('#authSubmit').onclick = async () => {
  const m = $('#authMsg');
  if (!$('#authRecover').hidden && $('#authRecover').value.trim()) {
    try {
      const r = await api('/api/recover', { method: 'POST', body: JSON.stringify({ code: $('#authRecover').value.trim() }) });
      m.style.color = 'var(--accent)';
      m.textContent = '恢复登录成功。新恢复码：' + r.newRecoveryCode + '（仅展示一次，请立即抄存）';
      boot();
    } catch (e) { m.style.color = 'var(--danger)'; m.textContent = e.message; }
    return;
  }
  const cred = { username: $('#authUser').value, password: $('#authPass').value };
  try { await api('/api/login', { method: 'POST', body: JSON.stringify(cred) }); boot(); }
  catch (e) {
    if (e.status === 409) {
      const s = await api('/api/setup', { method: 'POST', body: JSON.stringify(cred) });
      $('#authMsg').textContent = '初始化成功，恢复码：' + s.recoveryCode + '（请立即抄存）';
      await api('/api/login', { method: 'POST', body: JSON.stringify(cred) });
      boot();
    } else $('#authMsg').textContent = e.message;
  }
};
boot();
