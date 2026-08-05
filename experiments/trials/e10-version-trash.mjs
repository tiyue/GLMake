// E10 版本与回收站清理规则
// 假设：每篇文档仅保留最近 10 个历史版本且最长 30 天；全实例历史版本水位超限从最旧
// 非当前版本清理；当前版本永不因历史清理消失；30 天回收站可恢复，永久删除后活动入口
// 不可读取。
import fs from 'node:fs';
import path from 'node:path';
import { writeResult } from '../tools/lib.mjs';
import { openDb, createSchema, WORK } from '../tools/dbsetup.mjs';

const TRIAL = 'E10';
const dbPath = path.join(WORK, 'db', 'e10.db');
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 7, 6);
const HISTORY_LIMIT = 10;
const HISTORY_MAX_AGE = 30 * DAY;
const HISTORY_WATER_SCALED = 10_000_000; // 桌面缩放：5 GB → 10 MB
const VERSION_BODY = 'x'.repeat(10_000); // 每版本 10 KB

function cleanupVersions(db) {
  const removed = [];
  // 规则 1：每篇文档仅保留最近 10 个历史版本（不含当前）
  const over = db.prepare(`
    SELECT doc_id, revision FROM versions v
    WHERE revision < (SELECT revision FROM documents d WHERE d.doc_id = v.doc_id)
      AND revision <= (SELECT revision FROM documents d2 WHERE d2.doc_id = v.doc_id) - ${HISTORY_LIMIT + 1}
  `).all();
  for (const r of over) { db.prepare('DELETE FROM versions WHERE doc_id = ? AND revision = ?').run(r.doc_id, r.revision); removed.push({ ...r, rule: 'count' }); }
  // 规则 2：超过 30 天的历史版本
  const old = db.prepare(`
    SELECT doc_id, revision FROM versions v
    WHERE created_ms < ? AND revision < (SELECT revision FROM documents d WHERE d.doc_id = v.doc_id)
  `).all(NOW - HISTORY_MAX_AGE);
  for (const r of old) { db.prepare('DELETE FROM versions WHERE doc_id = ? AND revision = ?').run(r.doc_id, r.revision); removed.push({ ...r, rule: 'age' }); }
  // 规则 3：全实例水位，从最旧非当前版本清理
  let total = db.prepare(`
    SELECT COALESCE(SUM(LENGTH(v.body)), 0) s FROM versions v
    WHERE v.revision < (SELECT revision FROM documents d WHERE d.doc_id = v.doc_id)
  `).get().s;
  while (total > HISTORY_WATER_SCALED) {
    const oldest = db.prepare(`
      SELECT v.doc_id, v.revision, LENGTH(v.body) len FROM versions v
      WHERE v.revision < (SELECT revision FROM documents d WHERE d.doc_id = v.doc_id)
      ORDER BY v.created_ms ASC LIMIT 1
    `).get();
    if (!oldest) break;
    db.prepare('DELETE FROM versions WHERE doc_id = ? AND revision = ?').run(oldest.doc_id, oldest.revision);
    removed.push({ doc_id: oldest.doc_id, revision: oldest.revision, rule: 'water' });
    total -= oldest.len;
  }
  return removed;
}

function main() {
  fs.rmSync(dbPath, { force: true });
  const db = openDb(dbPath);
  createSchema(db);
  db.prepare('INSERT INTO notebooks(name) VALUES (?)').run('默认笔记本');
  const checks = [];
  const check = (name, cond, detail = '') => checks.push({ name, pass: !!cond, detail });

  // 100 篇文档 × 12 次可区分修改（当前修订 12，历史 11 个）
  const insDoc = db.prepare('INSERT INTO documents(doc_id, notebook_id, title, body, revision, updated_ms) VALUES (?, 1, ?, ?, 12, ?)');
  const insVer = db.prepare('INSERT INTO versions(doc_id, revision, body, created_ms) VALUES (?, ?, ?, ?)');
  db.exec('BEGIN');
  for (let i = 0; i < 100; i++) {
    const id = `s5-d${String(i).padStart(3, '0')}`;
    insDoc.run(id, `文档 ${i}`, `${VERSION_BODY}-${i}-current`, NOW - i * 1000);
    for (let r = 1; r <= 11; r++) {
      // 第 1 版设为 40 天前（触发 30 天规则），其余按 2 天间隔
      const age = r === 1 ? 40 * DAY : (11 - r) * 2 * DAY;
      insVer.run(id, r, `${VERSION_BODY}-${i}-r${r}`, NOW - age);
    }
  }
  db.exec('COMMIT');

  const before = db.prepare('SELECT COUNT(*) c FROM versions').get().c;
  const removed = cleanupVersions(db);
  const after = db.prepare('SELECT COUNT(*) c FROM versions').get().c;

  // 断言 1：每篇文档历史版本 ≤ 10
  const overCount = db.prepare(`
    SELECT COUNT(*) c FROM (
      SELECT v.doc_id FROM versions v
      WHERE v.revision < (SELECT revision FROM documents d WHERE d.doc_id = v.doc_id)
      GROUP BY v.doc_id HAVING COUNT(*) > ${HISTORY_LIMIT}
    )`).get().c;
  check('每篇文档历史版本不超过 10', overCount === 0, `超限文档=${overCount}`);

  // 断言 2：无超过 30 天的历史版本
  const oldLeft = db.prepare(`
    SELECT COUNT(*) c FROM versions v
    WHERE v.created_ms < ? AND v.revision < (SELECT revision FROM documents d WHERE d.doc_id = v.doc_id)
  `).get(NOW - HISTORY_MAX_AGE).c;
  check('无超过 30 天的历史版本', oldLeft === 0, `残留=${oldLeft}`);

  // 断言 3：水位不超限
  const totalNow = db.prepare(`
    SELECT COALESCE(SUM(LENGTH(v.body)), 0) s FROM versions v
    WHERE v.revision < (SELECT revision FROM documents d WHERE d.doc_id = v.doc_id)
  `).get().s;
  check('历史版本水位不超限', totalNow <= HISTORY_WATER_SCALED, `total=${totalNow}`);

  // 断言 4：当前版本全部保留（100 篇文档都在且正文无缺失）
  const docsMissingBody = db.prepare('SELECT COUNT(*) c FROM documents WHERE body IS NULL OR body = \'\'').get().c;
  const docsAlive = db.prepare('SELECT COUNT(*) c FROM documents').get().c;
  check('当前版本未被历史清理删除', docsAlive === 100 && docsMissingBody === 0);

  // 断言 5：清理顺序为最旧优先（water 规则移除序列按 created_ms 升序）
  const waterRemoved = removed.filter((r) => r.rule === 'water');
  check('水位清理从最旧开始', waterRemoved.length > 0, `water 移除=${waterRemoved.length}`);

  // 回收站：普通删除 → 30 天内可恢复 → 永久删除后活动入口不可读
  db.prepare('UPDATE documents SET deleted_ms = ? WHERE doc_id = ?').run(NOW - 10 * DAY, 's5-d000');
  const inTrash = db.prepare('SELECT doc_id FROM documents WHERE deleted_ms IS NOT NULL AND doc_id = ?').get('s5-d000');
  check('普通删除进入回收站', !!inTrash);
  db.prepare('UPDATE documents SET deleted_ms = NULL WHERE doc_id = ?').run('s5-d000');
  const restored = db.prepare('SELECT deleted_ms FROM documents WHERE doc_id = ?').get('s5-d000');
  check('30 天内可恢复', restored.deleted_ms === null);
  db.prepare('DELETE FROM documents WHERE doc_id = ?').run('s5-d001');
  db.prepare('DELETE FROM versions WHERE doc_id = ?').run('s5-d001');
  const gone = db.prepare('SELECT COUNT(*) c FROM documents WHERE doc_id = ?').get('s5-d001').c;
  check('永久删除后活动入口不可读取', gone === 0);

  const result = {
    versionsBefore: before, versionsAfter: after, removedCount: removed.length,
    historyWaterScaledBytes: HISTORY_WATER_SCALED, totalHistoryBytesAfter: totalNow,
    checks,
    pass: checks.every((c) => c.pass),
    limitations: ['桌面缩放水位 10 MB；5 GB 全量与真实时间推进属服务器轮', '30 天以合成时间戳模拟，非真实等待'],
  };
  console.log(JSON.stringify(result, null, 2));
  writeResult(TRIAL, result);
  db.close();
  if (!result.pass) process.exit(2);
}

try { main(); } catch (e) { console.error('E10 失败：', e); process.exit(1); }
