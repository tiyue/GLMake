// 试验用数据库公共模块：schema、S2 导入。仅用于阶段 2 试验。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SAMPLES = path.resolve(HERE, '../work/samples');
export const WORK = path.resolve(HERE, '../work');

export function openDb(dbPath, { wal = true } = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  if (wal) db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

export function createSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notebooks(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS tags(name TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS documents(
      doc_id TEXT PRIMARY KEY,
      notebook_id INTEGER REFERENCES notebooks(id),
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      updated_ms INTEGER NOT NULL,
      deleted_ms INTEGER
    );
    CREATE TABLE IF NOT EXISTS doc_tags(doc_id TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY(doc_id, tag));
    CREATE TABLE IF NOT EXISTS versions(doc_id TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, created_ms INTEGER NOT NULL, PRIMARY KEY(doc_id, revision));
    CREATE TABLE IF NOT EXISTS idempotency(request_id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, applied_ms INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS conflicts(doc_id TEXT NOT NULL, seq INTEGER, base_revision INTEGER, draft_body TEXT NOT NULL, server_revision INTEGER NOT NULL, created_ms INTEGER NOT NULL, PRIMARY KEY(doc_id, seq));
    CREATE TABLE IF NOT EXISTS attachments(hash TEXT PRIMARY KEY, size INTEGER NOT NULL, orig_name TEXT NOT NULL, refcount INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS idx_documents_updated ON documents(updated_ms);
    CREATE INDEX IF NOT EXISTS idx_documents_title ON documents(title);
  `);
}

export function readNdjson(relPath) {
  const text = fs.readFileSync(path.join(SAMPLES, relPath), 'utf8');
  return text.split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l));
}

export function readManifest() {
  return JSON.parse(fs.readFileSync(path.join(SAMPLES, 'manifest.json'), 'utf8'));
}

// 事务化导入 S2（1000 篇文档 + 笔记本 + 标签），返回耗时 ms
export function importS2(db) {
  const docs = readNdjson('S2/docs.ndjson');
  const notebooks = JSON.parse(fs.readFileSync(path.join(SAMPLES, 'S2/notebooks.json'), 'utf8'));
  const tags = JSON.parse(fs.readFileSync(path.join(SAMPLES, 'S2/tags.json'), 'utf8'));
  const t0 = process.hrtime.bigint();
  db.exec('BEGIN');
  try {
    const insNb = db.prepare('INSERT OR IGNORE INTO notebooks(name) VALUES (?)');
    for (const nb of notebooks) insNb.run(nb);
    const insTag = db.prepare('INSERT OR IGNORE INTO tags(name) VALUES (?)');
    for (const t of tags) insTag.run(t);
    const nbId = db.prepare('SELECT id FROM notebooks WHERE name = ?');
    const insDoc = db.prepare('INSERT INTO documents(doc_id, notebook_id, title, body, revision, updated_ms) VALUES (?, ?, ?, ?, 1, ?)');
    const insDT = db.prepare('INSERT INTO doc_tags(doc_id, tag) VALUES (?, ?)');
    for (const d of docs) {
      const nid = nbId.get(d.notebook).id;
      insDoc.run(d.doc_id, nid, d.title, d.body, d.updated_ms);
      for (const t of d.tags) insDT.run(d.doc_id, t);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return Number(process.hrtime.bigint() - t0) / 1e6;
}
