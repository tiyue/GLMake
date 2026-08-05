// E5 一致性快照
// 假设：并发写入期间 VACUUM INTO 可以完成，快照通过 integrity_check 且数据自洽。
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { writeResult, sha256Stream } from '../tools/lib.mjs';
import { openDb, createSchema, importS2, WORK } from '../tools/dbsetup.mjs';

const TRIAL = 'E5';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(WORK, 'db', 'e5.db');
const snapPath = path.join(WORK, 'db', 'e5-snapshot.db');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(snapPath, { force: true });
  const db = openDb(dbPath);
  createSchema(db);
  importS2(db);

  // 启动并发写入 worker
  const worker = new Worker(path.join(HERE, 'e5-writer-worker.mjs'), { workerData: { dbPath } });
  const workerDone = new Promise((resolve) => worker.on('message', resolve));
  await sleep(400); // 让写入先跑一段

  // 并发写入期间执行 VACUUM INTO 快照
  const t0 = process.hrtime.bigint();
  db.exec(`VACUUM INTO '${snapPath.replaceAll('\\', '/').replaceAll("'", "''")}'`);
  const snapshotMs = Number(process.hrtime.bigint() - t0) / 1e6;

  await sleep(400); // 快照后继续写入，证明不阻塞业务
  const revDuring = db.prepare('SELECT MAX(revision) m FROM documents').get().m;
  worker.postMessage('stop');
  const stats = await workerDone;
  db.close();

  // 校验快照：完整性 + 数据自洽（以只读方式打开）
  const snap = new (await import('node:sqlite')).DatabaseSync(snapPath, { readOnly: true });
  const integrity = snap.prepare('PRAGMA integrity_check').get();
  const snapDocs = snap.prepare('SELECT COUNT(*) c FROM documents').get().c;
  const snapTags = snap.prepare('SELECT COUNT(*) c FROM doc_tags').get().c;
  const snapMaxRev = snap.prepare('SELECT MAX(revision) m FROM documents').get().m;
  const snapNb = snap.prepare('SELECT COUNT(*) c FROM notebooks').get().c;
  // 自洽抽查：doc_tags 的 doc_id 必须都存在于 documents
  const orphan = snap.prepare('SELECT COUNT(*) c FROM doc_tags WHERE doc_id NOT IN (SELECT doc_id FROM documents)').get().c;
  snap.close();

  const snapStat = fs.statSync(snapPath);
  const snapHash = await sha256Stream(snapPath);

  const result = {
    snapshotMs: +snapshotMs.toFixed(2),
    writerStats: stats,
    maxRevisionAfterSnapshot: revDuring,
    snapshot: {
      integrityCheck: integrity,
      documents: snapDocs,
      docTags: snapTags,
      notebooks: snapNb,
      maxRevision: snapMaxRev,
      orphanDocTags: orphan,
      fileBytes: snapStat.size,
    },
    pass: integrity.integrity_check === 'ok'
      && snapDocs === 1000 && snapNb === 20 && orphan === 0
      && stats.writes > 0 && snapMaxRev >= 1 && snapMaxRev <= revDuring,
    _hashes: { 'e5-snapshot.db': snapHash.hash },
    limitations: [
      'VACUUM INTO 与 Online Backup API 语义接近但不等同；Online Backup API 需驱动支持，本轮以 VACUUM INTO 作为候选验证',
      '桌面机并发规模（单写入 worker），服务器轮需在 2 vCPU / 2 GiB 环境复测',
    ],
  };
  console.log(JSON.stringify(result, null, 2));
  writeResult(TRIAL, result);
  // worker 已关闭但线程对象仍会保活事件循环，试验结果已落盘，直接退出
  process.exit(result.pass ? 0 : 2);
}

main().catch((e) => { console.error('E5 失败：', e); process.exit(1); });
