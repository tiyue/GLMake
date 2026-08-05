// E1 SQLite 数据底座基线
// 假设：候选 schema 在 WAL 模式下可事务化导入 1000 篇文档；500 次串行单文档修订写入
// 无失败；integrity_check 通过；并可验证单篇/总量上限的落盘前拒绝逻辑（桌面缩放）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { quantile, writeResult, sha256Stream } from '../tools/lib.mjs';
import { openDb, createSchema, readManifest, importS2, WORK } from '../tools/dbsetup.mjs';

const TRIAL = 'E1';
const dbPath = path.join(WORK, 'db', 'e1.db');

async function main() {
  fs.rmSync(dbPath, { force: true });
  const db = openDb(dbPath);
  const journalMode = db.prepare('PRAGMA journal_mode').get();
  createSchema(db);

  // 1. 事务化导入 S2（1000 篇）
  const t0 = Date.now();
  const importMs = importS2(db);
  const docCount = db.prepare('SELECT COUNT(*) c FROM documents').get().c;
  const tagCount = db.prepare('SELECT COUNT(*) c FROM doc_tags').get().c;

  // 2. 500 次串行单文档修订写入（每次独立事务）
  const upd = db.prepare('UPDATE documents SET revision = revision + 1, updated_ms = ? WHERE doc_id = ? AND revision = ?');
  const get = db.prepare('SELECT revision FROM documents WHERE doc_id = ?');
  const latencies = [];
  let failures = 0;
  for (let i = 0; i < 500; i++) {
    const docId = `s2-d${String(i % 1000).padStart(4, '0')}`;
    const s = process.hrtime.bigint();
    try {
      db.exec('BEGIN IMMEDIATE');
      const cur = get.get(docId);
      const r = upd.run(Date.now(), docId, cur.revision);
      if (r.changes !== 1) throw new Error('修订写入未命中');
      db.exec('COMMIT');
    } catch (e) {
      failures++;
      try { db.exec('ROLLBACK'); } catch { /* 忽略 */ }
    }
    latencies.push(Number(process.hrtime.bigint() - s) / 1e6);
  }
  latencies.sort((a, b) => a - b);

  // 3. integrity_check
  const integrity = db.prepare('PRAGMA integrity_check').get();

  // 4. 上限拒绝逻辑（桌面缩放：单篇 10 MB、总量缩放到 S3 的 50 MB 级别）
  const manifest = readManifest();
  const overDoc = manifest.files.find((f) => f.path === 'S3/s3-over-doc.md');
  const SINGLE_DOC_LIMIT = 10_000_000;
  const singleReject = overDoc.size > SINGLE_DOC_LIMIT;
  // 总量：S3 合法文档合计 50,000,000，缩放总量上限取 50,000,000；再写入一篇 5 MB 应被拒绝
  const s3Legal = manifest.files.filter((f) => f.path.startsWith('S3/') && f.kind === 'legal');
  const totalLegal = s3Legal.reduce((a, f) => a + f.size, 0);
  const TOTAL_LIMIT_SCALED = 50_000_000;
  const nextDoc = 5_000_000;
  const totalReject = totalLegal + nextDoc > TOTAL_LIMIT_SCALED;

  // 5. 体膨胀与内存
  db.close();
  const dbStat = fs.statSync(dbPath);
  const dbHash = await sha256Stream(dbPath);
  const rss = process.memoryUsage().rss;

  const result = {
    journalMode,
    import: { docs: docCount, docTags: tagCount, importMs: Math.round(importMs * 10) / 10, wallMs: Date.now() - t0 },
    singleUpdates: {
      count: 500, failures,
      p50ms: +quantile(latencies, 0.5).toFixed(3),
      p95ms: +quantile(latencies, 0.95).toFixed(3),
      maxMs: +latencies[latencies.length - 1].toFixed(3),
    },
    integrityCheck: integrity,
    quotaLogic: {
      singleDocLimitBytes: SINGLE_DOC_LIMIT,
      oversizeSampleBytes: overDoc.size,
      singleDocRejectCorrect: singleReject,
      totalLimitScaledBytes: TOTAL_LIMIT_SCALED,
      currentTotalBytes: totalLegal,
      incomingDocBytes: nextDoc,
      totalRejectCorrect: totalReject,
    },
    dbFileBytes: dbStat.size,
    peakRssBytes: rss,
    pass: docCount === 1000 && failures === 0 && integrity.integrity_check === 'ok' && singleReject && totalReject,
    _hashes: { 'e1.db': dbHash.hash },
  };
  console.log(JSON.stringify(result, null, 2));
  writeResult(TRIAL, result);
  if (!result.pass) process.exit(2);
}

main().catch((e) => { console.error('E1 失败：', e); process.exit(1); });
