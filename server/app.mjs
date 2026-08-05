// GLMake 后端（M1 垂直切片）：零第三方依赖，Node ≥ 22.5
// 启动：node server/app.mjs（数据目录：GLMAKE_DATA 或 ./data；端口：PORT 或 8787）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { ZipWriter, ZipReader, isSafeEntryName } from './zip64.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DATA = path.resolve(process.env.GLMAKE_DATA || path.join(process.cwd(), 'data'));
const PORT = Number(process.env.PORT || 8787);

// ---------- 容量门槛（十进制，立项 §3.9/§3.11.4） ----------
export const LIMITS = {
  singleDoc: 10_000_000,
  totalBody: 5_000_000_000,
  singleAttachment: 50_000_000,
  totalAttachments: 500_000_000,
  historyPerDoc: 10,
  historyAgeMs: 30 * 86_400_000,
  historyTotal: 5_000_000_000,
  managed: 12_000_000_000,
  diskReserve: 8_000_000_000,
  sessionAgeMs: 30 * 86_400_000,
};

fs.mkdirSync(path.join(DATA, 'objects'), { recursive: true });
fs.mkdirSync(path.join(DATA, 'tmp'), { recursive: true });
const CONFIG = path.join(DATA, 'config.json');

export const db = new DatabaseSync(path.join(DATA, 'glmake.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = NORMAL');
db.exec('PRAGMA busy_timeout = 5000');
db.exec(`
CREATE TABLE IF NOT EXISTS notebooks(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS tags(name TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS documents(doc_id TEXT PRIMARY KEY, notebook_id INTEGER REFERENCES notebooks(id),
  title TEXT NOT NULL, body TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, updated_ms INTEGER NOT NULL, deleted_ms INTEGER);
CREATE TABLE IF NOT EXISTS doc_tags(doc_id TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY(doc_id, tag));
CREATE TABLE IF NOT EXISTS versions(doc_id TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, created_ms INTEGER NOT NULL, PRIMARY KEY(doc_id, revision));
CREATE TABLE IF NOT EXISTS idempotency(request_id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, applied_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS conflicts(doc_id TEXT NOT NULL, seq INTEGER NOT NULL, base_revision INTEGER NOT NULL, draft_body TEXT NOT NULL, server_revision INTEGER NOT NULL, created_ms INTEGER NOT NULL, PRIMARY KEY(doc_id, seq));
CREATE TABLE IF NOT EXISTS attachments(hash TEXT PRIMARY KEY, size INTEGER NOT NULL, mime TEXT NOT NULL, orig_name TEXT NOT NULL, refcount INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, created_ms INTEGER NOT NULL, expires_ms INTEGER NOT NULL, revoked_ms INTEGER);
CREATE TABLE IF NOT EXISTS recovery(code_hash TEXT PRIMARY KEY, created_ms INTEGER NOT NULL, used_ms INTEGER);
CREATE TABLE IF NOT EXISTS shares(token_hash TEXT PRIMARY KEY, doc_id TEXT NOT NULL, created_ms INTEGER NOT NULL, revoked_ms INTEGER);
CREATE TABLE IF NOT EXISTS changes(seq INTEGER PRIMARY KEY AUTOINCREMENT, doc_id TEXT NOT NULL, kind TEXT NOT NULL, ms INTEGER NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(doc_id UNINDEXED, title, body, tokenize = 'trigram');
`);

// ---------- 工具 ----------
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const now = () => Date.now();
export function json(res, code, obj, headers = {}) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length, ...headers });
  res.end(buf);
}
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > max) { reject(Object.assign(new Error('body_too_large'), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---------- 限速（登录/恢复/设置：每 IP 每分钟 5 次） ----------
const rate = new Map();
function rateLimited(ip) {
  const t = now(); const arr = (rate.get(ip) || []).filter((x) => x > t - 60_000);
  arr.push(t); rate.set(ip, arr);
  return arr.length > 5;
}

// ---------- 凭据 ----------
function scryptHash(password, salt) {
  return crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
}
export function ownerExists() { return fs.existsSync(CONFIG); }
export function createOwner(username, password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const recovery = crypto.randomBytes(24).toString('hex');
  const cfg = {
    username, salt, hashAlgo: 'scrypt-N16384-r8-p1',
    passHash: scryptHash(password, salt),
    recoveryHash: sha256(Buffer.from(recovery)),
    createdAt: now(),
  };
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  return recovery; // 一次性展示，之后仅存哈希
}
function verifyOwner(username, password) {
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  return cfg.username === username && scryptHash(password, cfg.salt) === cfg.passHash;
}

// ---------- 会话 ----------
function newSession() {
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions(token_hash, created_ms, expires_ms) VALUES (?, ?, ?)')
    .run(sha256(token), now(), now() + LIMITS.sessionAgeMs);
  return token;
}
export function sessionFromReq(req) {
  const m = /glmake_sid=([0-9a-f]{48})/.exec(req.headers.cookie || '');
  if (!m) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(sha256(m[1]));
  if (!row || row.revoked_ms !== null || row.expires_ms <= now()) return null;
  return m[1];
}
function requireAuth(req, res) {
  const s = sessionFromReq(req);
  if (!s) { json(res, 401, { error: '未登录' }); return null; }
  return s;
}

// ---------- 容量检查 ----------
export function diskFree() {
  const st = fs.statfsSync(DATA);
  return st.bavail * st.bsize;
}
export function managedBytes() {
  let total = 0;
  for (const f of ['glmake.db', 'glmake.db-wal']) {
    try { total += fs.statSync(path.join(DATA, f)).size; } catch { /* 不存在 */ }
  }
  total += db.prepare('SELECT COALESCE(SUM(size),0) s FROM attachments').get().s;
  return total;
}
function ensureCapacity(needBytes, res) {
  if (diskFree() < LIMITS.diskReserve + needBytes) {
    json(res, 507, { error: '磁盘保留空间不足，请先清理或导出后删除旧数据' }); return false;
  }
  if (managedBytes() + needBytes > LIMITS.managed) {
    json(res, 507, { error: '实例受管数据超过 12 GB 上限' }); return false;
  }
  return true;
}

// ---------- 变更序号 ----------
function recordChange(docId, kind) {
  db.prepare('INSERT INTO changes(doc_id, kind, ms) VALUES (?, ?, ?)').run(docId, kind, now());
}

// ---------- 全文索引同步（可整体重建的派生数据） ----------
function ftsUpsert(docId, title, body) {
  db.prepare('DELETE FROM docs_fts WHERE doc_id = ?').run(docId);
  db.prepare('INSERT INTO docs_fts(doc_id, title, body) VALUES (?,?,?)').run(docId, title, body);
}

// ---------- 版本清理（立项 §3.10.4） ----------
export function cleanupVersions() {
  db.prepare(`DELETE FROM versions WHERE revision <= (SELECT d.revision FROM documents d WHERE d.doc_id = versions.doc_id) - ${LIMITS.historyPerDoc + 1}
    AND revision < (SELECT d.revision FROM documents d WHERE d.doc_id = versions.doc_id)`).run();
  db.prepare(`DELETE FROM versions WHERE created_ms < ? AND revision < (SELECT d.revision FROM documents d WHERE d.doc_id = versions.doc_id)`)
    .run(now() - LIMITS.historyAgeMs);
  let total = db.prepare(`SELECT COALESCE(SUM(LENGTH(body)),0) s FROM versions WHERE revision < (SELECT d.revision FROM documents d WHERE d.doc_id = versions.doc_id)`).get().s;
  while (total > LIMITS.historyTotal) {
    const o = db.prepare(`SELECT doc_id, revision, LENGTH(body) len FROM versions WHERE revision < (SELECT d.revision FROM documents d WHERE d.doc_id = versions.doc_id) ORDER BY created_ms ASC LIMIT 1`).get();
    if (!o) break;
    db.prepare('DELETE FROM versions WHERE doc_id = ? AND revision = ?').run(o.doc_id, o.revision);
    total -= o.len;
  }
}

// ---------- 文档提交（修订号 + 幂等 + 冲突） ----------
export function commitDoc({ requestId, docId, baseRevision, body, title, notebook, tags, deletedMs = null }) {
  if (Buffer.byteLength(body) > LIMITS.singleDoc) return { error: 'single_doc_limit', status: 413 };
  db.exec('BEGIN IMMEDIATE');
  try {
    if (requestId && db.prepare('SELECT 1 FROM idempotency WHERE request_id = ?').get(requestId)) {
      db.exec('COMMIT'); return { duplicate: true, ok: true };
    }
    const cur = db.prepare('SELECT * FROM documents WHERE doc_id = ?').get(docId);
    if (!cur) { db.exec('ROLLBACK'); return { error: 'not_found', status: 404 }; }
    if (cur.revision !== baseRevision) {
      const seq = db.prepare('SELECT COUNT(*) c FROM conflicts WHERE doc_id = ?').get(docId).c + 1;
      db.prepare('INSERT INTO conflicts(doc_id, seq, base_revision, draft_body, server_revision, created_ms) VALUES (?,?,?,?,?,?)')
        .run(docId, seq, baseRevision, body, cur.revision, now());
      db.exec('COMMIT');
      return { conflict: true, status: 409, serverRevision: cur.revision };
    }
    db.prepare('INSERT INTO versions(doc_id, revision, body, created_ms) VALUES (?,?,?,?)').run(docId, cur.revision, cur.body, now());
    db.prepare('UPDATE documents SET body = ?, title = ?, revision = revision + 1, updated_ms = ?, deleted_ms = ? WHERE doc_id = ?')
      .run(body, title ?? cur.title, now(), deletedMs, docId);
    ftsUpsert(docId, title ?? cur.title, body);
    if (requestId) db.prepare('INSERT INTO idempotency(request_id, doc_id, applied_ms) VALUES (?,?,?)').run(requestId, docId, now());
    recordChange(docId, 'update');
    db.exec('COMMIT');
    cleanupVersions();
    return { ok: true, revision: cur.revision + 1 };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 忽略 */ }
    throw e;
  }
}

// ---------- 路由 ----------
const SAFE_IMAGE = { png: [0x89, 0x50, 0x4e, 0x47], jpeg: [0xff, 0xd8, 0xff], gif: [0x47, 0x49, 0x46], webp: [0x52, 0x49, 0x46, 0x46] };
function isSafeImage(buf) {
  for (const [mime, magic] of Object.entries(SAFE_IMAGE)) {
    if (buf.length > magic.length && magic.every((b, i) => buf[i] === b)) {
      if (mime === 'webp' && buf.slice(8, 12).toString() !== 'WEBP') continue;
      return mime;
    }
  }
  return null;
}

async function handleExport(res) {
  const dest = path.join(DATA, 'tmp', `export-${now()}.glmake.zip`);
  if (!ensureCapacity(managedBytes(), res)) return;
  const zw = new ZipWriter(dest);
  const docs = db.prepare('SELECT * FROM documents').all();
  const atts = db.prepare('SELECT * FROM attachments').all();
  const manifest = {
    format: 'glmake-export', format_version: 1, app_version: 'M1-0.1', exported_at: new Date().toISOString(),
    documents: docs.map((d) => ({ doc_id: d.doc_id, title: d.title, notebook: db.prepare('SELECT name FROM notebooks WHERE id = ?').get(d.notebook_id)?.name ?? null, tags: db.prepare('SELECT tag FROM doc_tags WHERE doc_id = ?').all(d.doc_id).map((r) => r.tag), revision: d.revision, updated_ms: d.updated_ms, deleted_ms: d.deleted_ms, path: `documents/${d.doc_id}.md`, sha256: sha256(Buffer.from(d.body)), size: Buffer.byteLength(d.body) })),
    attachments: atts.map((a) => ({ hash: a.hash, size: a.size, orig_name: a.orig_name, mime: a.mime, path: `attachments/${a.hash}` })),
  };
  for (const d of docs) zw.addBuffer(`documents/${d.doc_id}.md`, Buffer.from(d.body));
  for (const a of atts) {
    const p = path.join(DATA, 'objects', a.hash.slice(0, 2), a.hash);
    if (fs.existsSync(p)) await zw.addFile(`attachments/${a.hash}`, p);
  }
  zw.addBuffer('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));
  zw.finish();
  serveFile(res, dest, true);
}

function serveFile(res, filePath, isExport) {
  const stat = fs.statSync(filePath);
  res.writeHead(200, {
    'Content-Type': isExport ? 'application/zip' : 'application/octet-stream',
    'Content-Length': stat.size, 'Accept-Ranges': 'bytes',
    ...(isExport ? { 'Content-Disposition': 'attachment; filename="export.glmake.zip"' } : {}),
  });
  fs.createReadStream(filePath).pipe(res);
}

export async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    // ----- 公共：分享页 -----
    if (p.startsWith('/s/')) {
      const row = db.prepare('SELECT * FROM shares WHERE token_hash = ?').get(sha256(Buffer.from(p.slice(3))));
      res.setHeader('X-Robots-Tag', 'noindex');
      if (!row || row.revoked_ms !== null) { json(res, 404, { error: '分享不存在或已撤销' }); return; }
      const doc = db.prepare('SELECT * FROM documents WHERE doc_id = ? AND deleted_ms IS NULL').get(row.doc_id);
      if (!doc) { json(res, 404, { error: '文档不可用' }); return; }
      const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>${escapeHtml(doc.title)}</title></head><body><h1>${escapeHtml(doc.title)}</h1><pre>${escapeHtml(doc.body)}</pre></body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); return;
    }
    // ----- 静态 -----
    if (p === '/' || p === '/index.html') {
      const html = fs.readFileSync(path.join(HERE, 'static/index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': html.length }); res.end(html); return;
    }
    if (p.startsWith('/vendor/')) {
      const rel = p.slice(1);
      if (rel.includes('..')) { json(res, 400, { error: 'bad_path' }); return; }
      const file = path.join(HERE, 'static', rel);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { json(res, 404, { error: 'not_found' }); return; }
      const ext = path.extname(file);
      const type = ext === '.js' ? 'text/javascript; charset=utf-8' : ext === '.css' ? 'text/css; charset=utf-8' : ext === '.woff2' ? 'font/woff2' : ext === '.woff' ? 'font/woff' : ext === '.ttf' ? 'font/ttf' : 'application/octet-stream';
      const buf = fs.readFileSync(file);
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-cache' });
      res.end(buf); return;
    }
    if (!p.startsWith('/api/')) { json(res, 404, { error: 'not_found' }); return; }

    // ----- 认证相关 -----
    const ip = req.socket.remoteAddress || 'x';
    if (p === '/api/setup' && req.method === 'POST') {
      if (ownerExists()) { json(res, 409, { error: '所有者已存在' }); return; }
      if (rateLimited(ip)) { json(res, 429, { error: '请求过频' }); return; }
      const b = JSON.parse(await readBody(req, 10_000));
      if (!b.username || typeof b.password !== 'string' || b.password.length < 8) { json(res, 400, { error: '用户名或密码不符合要求（密码至少 8 位）' }); return; }
      const recovery = createOwner(b.username, b.password);
      json(res, 201, { ok: true, recoveryCode: recovery, warning: '恢复码仅展示一次，请立即妥善保存' }); return;
    }
    if (p === '/api/login' && req.method === 'POST') {
      if (!ownerExists()) { json(res, 409, { error: '尚未初始化' }); return; }
      if (rateLimited(ip)) { json(res, 429, { error: '请求过频' }); return; }
      const b = JSON.parse(await readBody(req, 10_000));
      if (!verifyOwner(b.username || '', b.password || '')) { json(res, 401, { error: '用户名或密码错误' }); return; }
      const token = newSession();
      json(res, 200, { ok: true }, { 'Set-Cookie': `glmake_sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${LIMITS.sessionAgeMs / 1000}` }); return;
    }
    if (p === '/api/logout' && req.method === 'POST') {
      const s = sessionFromReq(req);
      if (s) db.prepare('UPDATE sessions SET revoked_ms = ? WHERE token_hash = ?').run(now(), sha256(s));
      json(res, 200, { ok: true }, { 'Set-Cookie': 'glmake_sid=; HttpOnly; Path=/; Max-Age=0' }); return;
    }
    if (p === '/api/logout-all' && req.method === 'POST') {
      if (!requireAuth(req, res)) return;
      db.prepare('UPDATE sessions SET revoked_ms = ?').run(now());
      json(res, 200, { ok: true }, { 'Set-Cookie': 'glmake_sid=; HttpOnly; Path=/; Max-Age=0' }); return;
    }

    // ----- 以下均需登录 -----
    if (!requireAuth(req, res)) return;

    if (p === '/api/changes') {
      const since = Number(url.searchParams.get('since') || 0);
      json(res, 200, { changes: db.prepare('SELECT seq, doc_id, kind, ms FROM changes WHERE seq > ? ORDER BY seq').all(since), maxSeq: db.prepare('SELECT COALESCE(MAX(seq),0) m FROM changes').get().m }); return;
    }
    if (p === '/api/docs' && req.method === 'GET') {
      const includeDeleted = url.searchParams.get('deleted') === '1';
      const rows = db.prepare(`SELECT doc_id, title, revision, updated_ms, deleted_ms, (SELECT name FROM notebooks n WHERE n.id = documents.notebook_id) notebook FROM documents ${includeDeleted ? '' : 'WHERE deleted_ms IS NULL'} ORDER BY updated_ms DESC`).all();
      json(res, 200, { docs: rows }); return;
    }
    if (p === '/api/docs' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req, LIMITS.singleDoc + 10_000));
      if (Buffer.byteLength(b.body || '') > LIMITS.singleDoc) { json(res, 413, { error: '单篇正文超过 10 MB 上限' }); return; }
      const total = db.prepare('SELECT COALESCE(SUM(LENGTH(body)),0) s FROM documents WHERE deleted_ms IS NULL').get().s;
      if (total + Buffer.byteLength(b.body || '') > LIMITS.totalBody) { json(res, 507, { error: '活动正文合计超过 5 GB 上限' }); return; }
      if (!ensureCapacity(Buffer.byteLength(b.body || ''), res)) return;
      const docId = b.doc_id || crypto.randomBytes(12).toString('hex');
      if (db.prepare('SELECT 1 FROM documents WHERE doc_id = ?').get(docId)) { json(res, 409, { error: '文档已存在' }); return; }
      db.exec('BEGIN');
      let nbId = null;
      if (b.notebook) { db.prepare('INSERT OR IGNORE INTO notebooks(name) VALUES (?)').run(b.notebook); nbId = db.prepare('SELECT id FROM notebooks WHERE name = ?').get(b.notebook).id; }
      db.prepare('INSERT INTO documents(doc_id, notebook_id, title, body, revision, updated_ms) VALUES (?,?,?,?,1,?)')
        .run(docId, nbId, b.title || '无标题', b.body || '', now());
      ftsUpsert(docId, b.title || '无标题', b.body || '');
      for (const t of b.tags || []) { db.prepare('INSERT OR IGNORE INTO tags(name) VALUES (?)').run(t); db.prepare('INSERT OR IGNORE INTO doc_tags(doc_id, tag) VALUES (?,?)').run(docId, t); }
      if (b.request_id) db.prepare('INSERT OR IGNORE INTO idempotency(request_id, doc_id, applied_ms) VALUES (?,?,?)').run(b.request_id, docId, now());
      recordChange(docId, 'create');
      db.exec('COMMIT');
      json(res, 201, { doc_id: docId, revision: 1 }); return;
    }
    const docMatch = p.match(/^\/api\/docs\/([^/]+)(\/.*)?$/);
    if (docMatch) {
      const docId = docMatch[1]; const sub = docMatch[2] || '';
      if (sub === '' && req.method === 'GET') {
        const d = db.prepare('SELECT * FROM documents WHERE doc_id = ?').get(docId);
        if (!d) { json(res, 404, { error: 'not_found' }); return; }
        json(res, 200, { ...d, tags: db.prepare('SELECT tag FROM doc_tags WHERE doc_id = ?').all(docId).map((r) => r.tag) }); return;
      }
      if (sub === '' && req.method === 'PUT') {
        const b = JSON.parse(await readBody(req, LIMITS.singleDoc + 10_000));
        const r = commitDoc({ requestId: b.request_id, docId, baseRevision: b.base_revision, body: b.body ?? '', title: b.title, deletedMs: b.deleted_ms ?? undefined });
        if (r.error) { json(res, r.status, { error: r.error }); return; }
        if (r.conflict) { json(res, 409, { conflict: true, serverRevision: r.serverRevision }); return; }
        json(res, 200, { ok: true, revision: r.revision, duplicate: !!r.duplicate }); return;
      }
      if (sub === '/trash' && req.method === 'POST') {
        db.prepare('UPDATE documents SET deleted_ms = ? WHERE doc_id = ?').run(now(), docId);
        recordChange(docId, 'trash'); json(res, 200, { ok: true }); return;
      }
      if (sub === '/restore' && req.method === 'POST') {
        const d = db.prepare('SELECT deleted_ms FROM documents WHERE doc_id = ?').get(docId);
        if (!d) { json(res, 404, { error: 'not_found' }); return; }
        if (d.deleted_ms !== null && now() - d.deleted_ms > 30 * 86_400_000) { json(res, 410, { error: '回收站保留期已过' }); return; }
        db.prepare('UPDATE documents SET deleted_ms = NULL WHERE doc_id = ?').run(docId);
        recordChange(docId, 'restore'); json(res, 200, { ok: true }); return;
      }
      if (sub === '/purge' && req.method === 'POST') {
        db.prepare('DELETE FROM documents WHERE doc_id = ?').run(docId);
        db.prepare('DELETE FROM versions WHERE doc_id = ?').run(docId);
        db.prepare('DELETE FROM doc_tags WHERE doc_id = ?').run(docId);
        recordChange(docId, 'purge'); json(res, 200, { ok: true }); return;
      }
      if (sub === '/versions' && req.method === 'GET') {
        json(res, 200, { versions: db.prepare('SELECT revision, created_ms, LENGTH(body) size FROM versions WHERE doc_id = ? ORDER BY revision DESC').all(docId) }); return;
      }
    }
    if (p === '/api/search') {
      const q = url.searchParams.get('q') || '';
      if (q.length < 3) { json(res, 400, { error: '搜索关键词至少 3 个字符（trigram 索引限制）' }); return; }
      let rows;
      try {
        rows = db.prepare(`SELECT d.doc_id, d.title FROM docs_fts f JOIN documents d ON d.doc_id = f.doc_id WHERE docs_fts MATCH ? AND d.deleted_ms IS NULL LIMIT 100`).all(JSON.stringify(q));
      } catch { rows = []; }
      json(res, 200, { results: rows }); return;
    }
    // ----- 附件 -----
    if (p === '/api/attachments' && req.method === 'POST') {
      if (!ensureCapacity(LIMITS.singleAttachment, res)) return;
      const tmp = path.join(DATA, 'tmp', `up-${crypto.randomBytes(8).toString('hex')}`);
      const fd = fs.openSync(tmp, 'w');
      const h = crypto.createHash('sha256');
      let size = 0; let rejected = false;
      for await (const c of req) {
        size += c.length;
        if (size > LIMITS.singleAttachment) { rejected = true; break; }
        h.update(c); fs.writeSync(fd, c);
      }
      fs.closeSync(fd);
      if (rejected) { fs.rmSync(tmp, { force: true }); json(res, 413, { error: '单附件超过 50 MB 上限' }); return; }
      const hash = h.digest('hex');
      const totalAtt = db.prepare('SELECT COALESCE(SUM(size),0) s FROM attachments').get().s;
      const objPath = path.join(DATA, 'objects', hash.slice(0, 2), hash);
      if (!fs.existsSync(objPath) && totalAtt + size > LIMITS.totalAttachments) {
        fs.rmSync(tmp, { force: true }); json(res, 507, { error: '附件物理总量超过 500 MB 上限' }); return;
      }
      if (fs.existsSync(objPath)) { fs.rmSync(tmp, { force: true }); }
      else {
        fs.mkdirSync(path.dirname(objPath), { recursive: true });
        fs.renameSync(tmp, objPath);
      }
      const mime = req.headers['x-glmake-mime'] || 'application/octet-stream';
      const name = req.headers['x-glmake-name'] || 'attachment';
      db.prepare('INSERT INTO attachments(hash, size, mime, orig_name, refcount) VALUES (?,?,?,?,1) ON CONFLICT(hash) DO UPDATE SET refcount = refcount + 1')
        .run(hash, size, mime, name);
      json(res, 201, { hash, size, deduped: fs.existsSync(objPath) }); return;
    }
    const attMatch = p.match(/^\/api\/attachments\/([0-9a-f]{64})$/);
    if (attMatch && req.method === 'GET') {
      const a = db.prepare('SELECT * FROM attachments WHERE hash = ?').get(attMatch[1]);
      const objPath = path.join(DATA, 'objects', a.hash.slice(0, 2), a.hash);
      if (!a || !fs.existsSync(objPath)) { json(res, 404, { error: 'not_found' }); return; }
      const buf = fs.readFileSync(objPath);
      const safe = isSafeImage(buf);
      const inline = url.searchParams.get('inline') === '1' && safe;
      res.writeHead(200, {
        'Content-Type': inline ? `image/${safe}` : 'application/octet-stream',
        'Content-Disposition': inline ? 'inline' : `attachment; filename="${encodeURIComponent(a.orig_name)}"`,
        'X-Content-Type-Options': 'nosniff', 'Content-Length': buf.length, 'Cache-Control': 'private, max-age=31536000, immutable',
      });
      res.end(buf); return;
    }
    // ----- 分享 -----
    if (p === '/api/shares' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req, 10_000));
      if (!db.prepare('SELECT 1 FROM documents WHERE doc_id = ? AND deleted_ms IS NULL').get(b.doc_id)) { json(res, 404, { error: '文档不存在' }); return; }
      const token = crypto.randomBytes(16).toString('hex');
      db.prepare('INSERT INTO shares(token_hash, doc_id, created_ms) VALUES (?,?,?)').run(sha256(Buffer.from(token)), b.doc_id, now());
      json(res, 201, { token, url: `/s/${token}` }); return;
    }
    const shareMatch = p.match(/^\/api\/shares\/([0-9a-f]{32})$/);
    if (shareMatch && req.method === 'DELETE') {
      db.prepare('UPDATE shares SET revoked_ms = ? WHERE token_hash = ?').run(now(), sha256(Buffer.from(shareMatch[1])));
      json(res, 200, { ok: true }); return;
    }
    // ----- 导出/导入 -----
    if (p === '/api/export' && req.method === 'POST') { await handleExport(res); return; }
    if (p === '/api/import' && req.method === 'POST') {
      const buf = await readBody(req, 2_000_000_000);
      const tmp = path.join(DATA, 'tmp', `import-${now()}.zip`);
      fs.writeFileSync(tmp, buf);
      let zr;
      try { zr = new ZipReader(tmp); } catch { json(res, 400, { error: '归档无法读取' }); return; }
      for (const e of zr.entries) {
        if (!isSafeEntryName(e.name)) { zr.close(); fs.rmSync(tmp, { force: true }); json(res, 400, { error: `不安全条目：${e.name}` }); return; }
      }
      const manEntry = zr.entries.find((e) => e.name === 'manifest.json');
      if (!manEntry) { zr.close(); json(res, 400, { error: '缺少 manifest.json' }); return; }
      const manifest = JSON.parse(zr.readEntry(manEntry).toString('utf8'));
      for (const d of manifest.documents) {
        const e = zr.entries.find((x) => x.name === d.path);
        if (!e || e.size !== d.size) { zr.close(); json(res, 400, { error: `条目缺失或大小不符：${d.path}` }); return; }
        const data = zr.readEntry(e);
        if (sha256(data) !== d.sha256) { zr.close(); json(res, 400, { error: `哈希不符：${d.path}` }); return; }
      }
      // 校验通过：替换业务数据（会话与凭据保留）
      db.exec('BEGIN');
      try {
        for (const t of ['doc_tags', 'versions', 'documents', 'notebooks', 'tags', 'attachments', 'shares']) db.prepare(`DELETE FROM ${t}`).run();
        for (const d of manifest.documents) {
          let nbId = null;
          if (d.notebook) { db.prepare('INSERT OR IGNORE INTO notebooks(name) VALUES (?)').run(d.notebook); nbId = db.prepare('SELECT id FROM notebooks WHERE name = ?').get(d.notebook).id; }
          const data = zr.readEntry(zr.entries.find((x) => x.name === d.path));
          db.prepare('INSERT INTO documents(doc_id, notebook_id, title, body, revision, updated_ms, deleted_ms) VALUES (?,?,?,?,?,?,?)')
            .run(d.doc_id, nbId, d.title, data.toString('utf8'), d.revision, d.updated_ms, d.deleted_ms ?? null);
          for (const t of d.tags || []) db.prepare('INSERT OR IGNORE INTO doc_tags(doc_id, tag) VALUES (?,?)').run(d.doc_id, t);
        }
        for (const a of manifest.attachments) {
          const e = zr.entries.find((x) => x.name === a.path);
          if (e) {
            const data = zr.readEntry(e);
            const dir = path.join(DATA, 'objects', a.hash.slice(0, 2));
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, a.hash), data);
            db.prepare('INSERT OR IGNORE INTO attachments(hash, size, mime, orig_name, refcount) VALUES (?,?,?,?,1)').run(a.hash, a.size, a.mime || 'application/octet-stream', a.orig_name || a.hash);
          }
        }
        db.exec('COMMIT');
      } catch (e2) { db.exec('ROLLBACK'); throw e2; }
      zr.close(); fs.rmSync(tmp, { force: true });
      json(res, 200, { ok: true, documents: manifest.documents.length, attachments: manifest.attachments.length }); return;
    }
    if (p === '/api/quota') {
      json(res, 200, { diskFreeBytes: diskFree(), managedBytes: managedBytes(), limits: LIMITS }); return;
    }
    json(res, 404, { error: 'not_found' });
  } catch (e) {
    const code = e.code === 413 ? 413 : 500;
    if (!res.headersSent) json(res, code, { error: code === 413 ? '请求体过大' : String(e.message || e) });
    else res.end();
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function startServer(port = PORT) {
  const server = http.createServer((req, res) => { handle(req, res); });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

export function stopServer(server) {
  server.close();
  try { db.close(); } catch { /* 已关闭 */ }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startServer().then(() => console.log(`GLMake M1 已启动：http://127.0.0.1:${PORT}（数据目录 ${DATA}）`));
}
