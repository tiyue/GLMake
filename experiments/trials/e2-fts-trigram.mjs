// E2 FTS5 trigram 中文搜索
// 假设：trigram 索引可命中 ≥3 字符的中文/英文/数字/混合查询；索引可整体重建且结果一致；
// 少于 3 字符的查询存在已知限制（记录实际行为，不静默通过）。
import fs from 'node:fs';
import path from 'node:path';
import { quantile, writeResult } from '../tools/lib.mjs';
import { openDb, createSchema, importS2, readNdjson, WORK } from '../tools/dbsetup.mjs';

const TRIAL = 'E2';
const dbPath = path.join(WORK, 'db', 'e2.db');

const QUERIES = [
  { id: 'cn3', text: '全文搜', expect: 'hits' },
  { id: 'cn6', text: '回收站保留', expect: 'hits' },
  { id: 'en', text: 'snapshot', expect: 'hits' },
  { id: 'num', text: '2026', expect: 'hits' },
  { id: 'mixed', text: 'abc-995', expect: 'hits' },
  { id: 'cn2', text: '搜索', expect: 'limited' },
];

function groundTruth(docs, q) {
  // 独立于 FTS 的朴素子串扫描，作为命中数量的对照基准
  return docs.filter((d) => d.body.includes(q) || d.title.includes(q)).length;
}

function createFts(db) {
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(doc_id UNINDEXED, title, body, tokenize = 'trigram')`);
}

function fillFts(db) {
  db.exec('BEGIN');
  db.exec('DELETE FROM docs_fts');
  db.exec(`INSERT INTO docs_fts(doc_id, title, body) SELECT doc_id, title, body FROM documents`);
  db.exec('COMMIT');
}

function ftsCount(db, text) {
  // trigram 查询需作为短语传入
  const stmt = db.prepare('SELECT COUNT(*) c FROM docs_fts WHERE docs_fts MATCH ?');
  return stmt.get(JSON.stringify(text)).c;
}

async function main() {
  fs.rmSync(dbPath, { force: true });
  const db = openDb(dbPath);
  createSchema(db);
  const importMs = importS2(db);
  const docs = readNdjson('S2/docs.ndjson');

  // 1. 建立索引
  createFts(db);
  const t0 = Date.now();
  fillFts(db);
  const buildMs = Date.now() - t0;
  const ftsRows = db.prepare('SELECT COUNT(*) c FROM docs_fts').get().c;

  // 2. 查询正确性与耗时
  const perQuery = {};
  let correct = true;
  for (const q of QUERIES) {
    const truth = groundTruth(docs, q.text);
    let fts = null;
    let error = null;
    try {
      fts = ftsCount(db, q.text);
    } catch (e) {
      error = e.message;
    }
    const latencies = [];
    for (let i = 0; i < 30; i++) {
      const s = process.hrtime.bigint();
      try { ftsCount(db, q.text); } catch { break; }
      latencies.push(Number(process.hrtime.bigint() - s) / 1e6);
    }
    latencies.sort((a, b) => a - b);
    const ok = q.expect === 'limited'
      ? true // 已知限制类：如实记录实际行为（报错或命中偏差），不作为失败条件
      : (error === null && fts === truth);
    if (!ok) correct = false;
    perQuery[q.id] = {
      text: q.text,
      expected: q.expect,
      groundTruthHits: truth,
      ftsHits: fts,
      ftsError: error,
      p95ms: latencies.length ? +quantile(latencies, 0.95).toFixed(3) : null,
      match: ok,
    };
  }

  // 3. 索引整体重建：结果必须一致
  const before = {};
  for (const q of QUERIES) {
    try { before[q.id] = ftsCount(db, q.text); } catch { before[q.id] = 'error'; }
  }
  db.exec('DROP TABLE docs_fts');
  createFts(db);
  const t1 = Date.now();
  fillFts(db);
  const rebuildMs = Date.now() - t1;
  const after = {};
  for (const q of QUERIES) {
    try { after[q.id] = ftsCount(db, q.text); } catch { after[q.id] = 'error'; }
  }
  const rebuildConsistent = JSON.stringify(before) === JSON.stringify(after);

  const sizeAfter = fs.statSync(dbPath).size;
  db.close();

  const result = {
    importMs: Math.round(importMs * 10) / 10,
    indexBuild: { rows: ftsRows, buildMs, rebuildMs, rebuildConsistent },
    queries: perQuery,
    allQueriesBehaveAsDocumented: correct,
    dbFileBytes: sizeAfter,
    pass: ftsRows === 1000 && correct && rebuildConsistent,
    limitations: [
      'trigram 对少于 3 个字符的查询存在限制（见 cn2 的实际行为记录）',
      '桌面机观察值，不代表目标服务器性能',
    ],
  };
  console.log(JSON.stringify(result, null, 2));
  writeResult(TRIAL, result);
  if (!result.pass) process.exit(2);
}

main().catch((e) => { console.error('E2 失败：', e); process.exit(1); });
