// S2 规模门禁检查（桌面观察级）：1000 篇下列表/搜索/无变更同步
// 用法：先 node experiments/tools/gen-samples.mjs，再 node tools/s2-gate-check.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
process.env.GLMAKE_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'glmake-s2-'));
const { startServer, stopServer, db } = await import(pathToFileURL(path.join(ROOT, 'server/app.mjs')).href);

const PORT = 8397;
const B = `http://127.0.0.1:${PORT}`;
const server = await startServer(PORT);

// 初始化 + 登录
await fetch(B + '/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'o', password: 's2-gate-password' }) });
const lg = await fetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'o', password: 's2-gate-password' }) });
const cookie = lg.headers.get('set-cookie').split(';')[0];
const H = { 'Content-Type': 'application/json', cookie };

// 播种 S2（1000 篇，单事务直写数据库以加速）
const docs = fs.readFileSync(path.join(ROOT, 'experiments/work/samples/S2/docs.ndjson'), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));
const notebooks = JSON.parse(fs.readFileSync(path.join(ROOT, 'experiments/work/samples/S2/notebooks.json'), 'utf8'));
db.exec('BEGIN');
for (const n of notebooks) db.prepare('INSERT OR IGNORE INTO notebooks(name) VALUES (?)').run(n);
const nbId = db.prepare('SELECT id FROM notebooks WHERE name = ?');
const insDoc = db.prepare('INSERT OR REPLACE INTO documents(doc_id, notebook_id, title, body, revision, updated_ms) VALUES (?,?,?,?,1,?)');
const insDT = db.prepare('INSERT OR REPLACE INTO doc_tags(doc_id, tag) VALUES (?,?)');
const insFts = db.prepare('INSERT INTO docs_fts(doc_id, title, body) VALUES (?,?,?)');
for (const d of docs) {
  insDoc.run(d.doc_id, nbId.get(d.notebook).id, d.title, d.body, d.updated_ms);
  for (const t of d.tags) insDT.run(d.doc_id, t);
  insFts.run(d.doc_id, d.title, d.body);
}
db.exec('COMMIT');
console.log('播种完成：', db.prepare('SELECT COUNT(*) c FROM documents').get().c, '篇');

// 1) 列表（热）
const listTimes = [];
for (let i = 0; i < 5; i++) {
  const t0 = Date.now();
  const r = await fetch(B + '/api/docs', { headers: { cookie } });
  const j = await r.json();
  listTimes.push({ ms: Date.now() - t0, count: j.docs.length });
}
// 2) 搜索（标题命中样本）
const searchTimes = [];
for (const q of ['排序冲突样本', '同步与冲突', 'S2 文档 0500']) {
  const t0 = Date.now();
  const r = await fetch(B + '/api/search?q=' + encodeURIComponent(q), { headers: { cookie } });
  const j = await r.json();
  searchTimes.push({ q, ms: Date.now() - t0, hits: j.results.length });
}
// 3) 无变更同步：since=当前最大 seq；前后 changes 计数与 db 写入对比
const maxSeq = db.prepare('SELECT COALESCE(MAX(seq),0) m FROM changes').get().m;
const syncTimes = [];
for (let i = 0; i < 5; i++) {
  const t0 = Date.now();
  const r = await fetch(B + `/api/changes?since=${maxSeq}`, { headers: { cookie } });
  const j = await r.json();
  syncTimes.push({ ms: Date.now() - t0, changes: j.changes.length });
}
const revSumBefore = db.prepare('SELECT COALESCE(SUM(revision),0) s FROM documents').get().s;
await new Promise((r) => setTimeout(r, 500));
const revSumAfter = db.prepare('SELECT COALESCE(SUM(revision),0) s FROM documents').get().s;

const result = {
  docs: docs.length,
  list: listTimes,
  search: searchTimes,
  noChangeSync: { since: maxSeq, syncTimes, wroteNothing: revSumBefore === revSumAfter },
  gates: {
    listFirstOperableRef3s: Math.max(...listTimes.map((x) => x.ms)) <= 3000,
    searchP95Ref2s: Math.max(...searchTimes.map((x) => x.ms)) <= 2000,
    noChangeSyncP95Ref10s: Math.max(...syncTimes.map((x) => x.ms)) <= 10000,
    noWritesOnNoChange: revSumBefore === revSumAfter,
  },
  note: '桌面观察级；正式门禁需在目标服务器与正式浏览器复测',
};
console.log(JSON.stringify(result, null, 2));
const evDir = path.join(ROOT, 'experiments/evidence/2026-08-06-desktop-r2');
fs.mkdirSync(evDir, { recursive: true });
fs.writeFileSync(path.join(evDir, 'S2-gates.json'), JSON.stringify(result, null, 2));
stopServer(server);
process.exit(0);
