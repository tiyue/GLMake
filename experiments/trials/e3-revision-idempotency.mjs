// E3 修订号冲突与幂等
// 假设：携带落后 base_revision 的写入 100% 返回冲突且不改变服务器版本；
// 相同幂等请求重复 100 次只产生一次业务变化；四条处理路径不丢失未选内容。
import fs from 'node:fs';
import path from 'node:path';
import { writeResult, sha256Buffer } from '../tools/lib.mjs';
import { openDb, createSchema, WORK } from '../tools/dbsetup.mjs';

const TRIAL = 'E3';
const dbPath = path.join(WORK, 'db', 'e3.db');

// 模拟服务器提交：返回 { ok, revision } 或 { conflict: true, serverRevision }
function commit(db, { requestId, docId, baseRevision, body, nowMs }) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const seen = db.prepare('SELECT doc_id FROM idempotency WHERE request_id = ?').get(requestId);
    if (seen) { db.exec('COMMIT'); return { ok: true, duplicate: true }; }
    const cur = db.prepare('SELECT revision, body FROM documents WHERE doc_id = ?').get(docId);
    if (!cur) { db.exec('ROLLBACK'); return { error: 'doc_not_found' }; }
    if (cur.revision !== baseRevision) {
      // 冲突：不得覆盖；保留来稿到 conflicts，保留服务器版本
      const seq = db.prepare('SELECT COUNT(*) c FROM conflicts WHERE doc_id = ?').get(docId).c + 1;
      db.prepare('INSERT INTO conflicts(doc_id, seq, base_revision, draft_body, server_revision, created_ms) VALUES (?, ?, ?, ?, ?, ?)')
        .run(docId, seq, baseRevision, body, cur.revision, nowMs);
      db.exec('COMMIT');
      return { conflict: true, serverRevision: cur.revision };
    }
    const next = cur.revision + 1;
    db.prepare('UPDATE documents SET body = ?, revision = ?, updated_ms = ? WHERE doc_id = ?')
      .run(body, next, nowMs, docId);
    db.prepare('INSERT INTO versions(doc_id, revision, body, created_ms) VALUES (?, ?, ?, ?)')
      .run(docId, cur.revision, cur.body, nowMs);
    db.prepare('INSERT INTO idempotency(request_id, doc_id, applied_ms) VALUES (?, ?, ?)')
      .run(requestId, docId, nowMs);
    db.exec('COMMIT');
    return { ok: true, revision: next };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 忽略 */ }
    throw e;
  }
}

function main() {
  fs.rmSync(dbPath, { force: true });
  const db = openDb(dbPath);
  createSchema(db);

  const B1 = '# 文档\n\n初始正文。';
  const B2 = '# 文档\n\n浏览器 A 的修改。';
  const B3 = '# 文档\n\n浏览器 B 的修改。';
  const B4 = '# 文档\n\n双方合并后的最终正文。';
  const docId = 's6-demo-001';
  db.prepare('INSERT INTO notebooks(name) VALUES (?)').run('默认笔记本');
  db.prepare('INSERT INTO documents(doc_id, notebook_id, title, body, revision, updated_ms) VALUES (?, 1, ?, ?, 1, ?)')
    .run(docId, '文档', B1, 1000);

  const checks = [];
  const check = (name, cond, detail = '') => checks.push({ name, pass: !!cond, detail });

  // 1. A 基于 rev1 提交成功
  const r1 = commit(db, { requestId: 'req-A1', docId, baseRevision: 1, body: B2, nowMs: 2000 });
  check('A 基于最新修订提交成功', r1.ok && r1.revision === 2);

  // 2. B 基于过期 rev1 提交必须冲突，且服务器版本不被覆盖
  const r2 = commit(db, { requestId: 'req-B1', docId, baseRevision: 1, body: B3, nowMs: 3000 });
  const serverNow = db.prepare('SELECT body, revision FROM documents WHERE doc_id = ?').get(docId);
  check('B 的过期写入返回冲突', r2.conflict === true);
  check('冲突后服务器版本未被覆盖', serverNow.revision === 2 && serverNow.body === B2);
  check('B 的草稿已保留到 conflicts', db.prepare('SELECT COUNT(*) c FROM conflicts WHERE doc_id = ?').get(docId).c === 1);

  // 3. 四条处理路径的数据完整性（以"另存为两个文档"为代表验证双方内容都在）
  const conflictRow = db.prepare('SELECT * FROM conflicts WHERE doc_id = ?').get(docId);
  db.prepare('INSERT INTO documents(doc_id, notebook_id, title, body, revision, updated_ms) VALUES (?, 1, ?, ?, 1, ?)')
    .run(docId + '-copy', '文档（冲突另存）', conflictRow.draft_body, 3000);
  check('另存后本地版内容完整', db.prepare('SELECT body FROM documents WHERE doc_id = ?').get(docId + '-copy').body === B3);
  check('另存后云端版内容完整', db.prepare('SELECT body FROM documents WHERE doc_id = ?').get(docId).body === B2);

  // 4. 幂等：相同 request_id 重复 100 次只产生一次业务变化
  const versionsBefore = db.prepare('SELECT COUNT(*) c FROM versions WHERE doc_id = ?').get(docId).c;
  let applied = 0, dup = 0;
  for (let i = 0; i < 100; i++) {
    const r = commit(db, { requestId: 'req-A2', docId, baseRevision: 2, body: B4, nowMs: 4000 });
    if (r.duplicate) dup++; else if (r.ok) applied++;
  }
  const versionsAfter = db.prepare('SELECT COUNT(*) c FROM versions WHERE doc_id = ?').get(docId).c;
  const finalRev = db.prepare('SELECT revision FROM documents WHERE doc_id = ?').get(docId).revision;
  const idempotencyRows = db.prepare('SELECT COUNT(*) c FROM idempotency WHERE request_id = ?').get('req-A2').c;
  check('100 次相同请求只应用 1 次', applied === 1 && dup === 99);
  check('版本表只新增一条', versionsAfter === versionsBefore + 1);
  check('最终修订号为 3', finalRev === 3);
  check('幂等键只有一条记录', idempotencyRows === 1);
  check('最终正文正确', db.prepare('SELECT body FROM documents WHERE doc_id = ?').get(docId).body === B4);

  const result = {
    checks,
    contentHashes: { B2: sha256Buffer(Buffer.from(B2)), B3: sha256Buffer(Buffer.from(B3)), B4: sha256Buffer(Buffer.from(B4)) },
    pass: checks.every((c) => c.pass),
  };
  console.log(JSON.stringify(result, null, 2));
  writeResult(TRIAL, result);
  db.close();
  if (!result.pass) process.exit(2);
}

try { main(); } catch (e) { console.error('E3 失败：', e); process.exit(1); }
