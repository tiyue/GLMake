// E5 写入 worker：持续对同一数据库做单文档修订写入，直到收到 stop
import { parentPort, workerData } from 'node:worker_threads';
import { openDb } from '../tools/dbsetup.mjs';

const db = openDb(workerData.dbPath);
const pick = db.prepare('SELECT doc_id, revision FROM documents ORDER BY RANDOM() LIMIT 1');
const upd = db.prepare('UPDATE documents SET revision = revision + 1, updated_ms = ? WHERE doc_id = ? AND revision = ?');

let running = true;
parentPort.on('message', (m) => { if (m === 'stop') running = false; });

let writes = 0;
let busyErrors = 0;

async function loop() {
  while (running) {
    try {
      db.exec('BEGIN IMMEDIATE');
      const row = pick.get();
      upd.run(Date.now(), row.doc_id, row.revision);
      db.exec('COMMIT');
      writes++;
    } catch (e) {
      busyErrors++;
      try { db.exec('ROLLBACK'); } catch { /* 忽略 */ }
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  db.close();
  parentPort.postMessage({ writes, busyErrors });
}

loop();
