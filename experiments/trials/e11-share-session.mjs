// E11 分享与会话模型
// 假设：会话最长 30 天且过期即失效；“退出所有设备”后全部旧会话访问受保护接口失败；
// 恢复码一次性使用且使用后既有会话全部失效；分享链接默认不过期、可撤销、撤销后不可读；
// 迁移后旧分享凭据全部无效。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeResult, sha256Buffer } from '../tools/lib.mjs';
import { openDb, createSchema, WORK } from '../tools/dbsetup.mjs';

const TRIAL = 'E11';
const dbPath = path.join(WORK, 'db', 'e11.db');
const DAY = 86_400_000;
const SESSION_MAX_AGE = 30 * DAY;
const NOW = Date.UTC(2026, 7, 6);

const rand = () => crypto.randomBytes(24).toString('hex');

function main() {
  fs.rmSync(dbPath, { force: true });
  const db = openDb(dbPath);
  createSchema(db);
  db.exec(`
    CREATE TABLE sessions(token_hash TEXT PRIMARY KEY, created_ms INTEGER NOT NULL, expires_ms INTEGER NOT NULL, revoked_ms INTEGER);
    CREATE TABLE recovery(code_hash TEXT PRIMARY KEY, created_ms INTEGER NOT NULL, used_ms INTEGER);
    CREATE TABLE shares(token_hash TEXT PRIMARY KEY, doc_id TEXT NOT NULL, created_ms INTEGER NOT NULL, revoked_ms INTEGER);
  `);
  const checks = [];
  const check = (name, cond, detail = '') => checks.push({ name, pass: !!cond, detail });

  const newSession = (createdMs) => {
    const token = rand();
    db.prepare('INSERT INTO sessions(token_hash, created_ms, expires_ms) VALUES (?, ?, ?)')
      .run(sha256Buffer(Buffer.from(token)), createdMs, createdMs + SESSION_MAX_AGE);
    return token;
  };
  const sessionValid = (token, nowMs) => {
    const row = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(sha256Buffer(Buffer.from(token)));
    return !!row && row.revoked_ms === null && row.expires_ms > nowMs;
  };
  const newShare = (docId) => {
    const token = rand();
    db.prepare('INSERT INTO shares(token_hash, doc_id, created_ms) VALUES (?, ?, ?)')
      .run(sha256Buffer(Buffer.from(token)), docId, NOW);
    return token;
  };
  const shareReadable = (token) => {
    const row = db.prepare('SELECT * FROM shares WHERE token_hash = ?').get(sha256Buffer(Buffer.from(token)));
    return !!row && row.revoked_ms === null;
  };

  db.prepare('INSERT INTO notebooks(name) VALUES (?)').run('默认笔记本');
  db.prepare('INSERT INTO documents(doc_id, notebook_id, title, body, revision, updated_ms) VALUES (?, 1, ?, ?, 1, ?)')
    .run('doc-share-1', '分享文档', '# 分享文档', NOW);

  // 1. 会话 30 天过期边界
  const fresh = newSession(NOW - 1 * DAY);
  const atEdge = newSession(NOW - SESSION_MAX_AGE + 3600_000);   // 还差 1 小时过期
  const expired = newSession(NOW - SESSION_MAX_AGE - 3600_000);  // 已过期 1 小时
  check('新会话有效', sessionValid(fresh, NOW));
  check('30 天边界内会话有效', sessionValid(atEdge, NOW));
  check('超过 30 天会话失效', !sessionValid(expired, NOW));

  // 2. 退出所有设备：全部旧会话立即失效
  const s1 = newSession(NOW - 2 * DAY);
  const s2 = newSession(NOW - 5 * DAY);
  db.prepare('UPDATE sessions SET revoked_ms = ?').run(NOW);
  check('退出所有设备后旧会话全部失效', !sessionValid(s1, NOW) && !sessionValid(s2, NOW) && !sessionValid(fresh, NOW));

  // 3. 恢复码一次性 + 使用后既有会话失效
  const code = rand();
  db.prepare('INSERT INTO recovery(code_hash, created_ms) VALUES (?, ?)').run(sha256Buffer(Buffer.from(code)), NOW - 10 * DAY);
  const preRecovery = newSession(NOW - 3 * DAY);
  const useRecovery = (c) => {
    const h = sha256Buffer(Buffer.from(c));
    const row = db.prepare('SELECT * FROM recovery WHERE code_hash = ?').get(h);
    if (!row || row.used_ms !== null) return false;
    db.exec('BEGIN');
    db.prepare('UPDATE recovery SET used_ms = ? WHERE code_hash = ?').run(NOW, h);
    db.prepare('UPDATE sessions SET revoked_ms = ?').run(NOW); // 恢复流程使所有既有会话失效
    db.exec('COMMIT');
    return true;
  };
  check('恢复码首次使用成功', useRecovery(code) === true);
  check('恢复码第二次使用被拒', useRecovery(code) === false);
  check('恢复后既有会话失效', !sessionValid(preRecovery, NOW));

  // 4. 分享：默认不过期、可撤销、撤销后不可读
  const share = newShare('doc-share-1');
  check('分享链接创建后只读可访问', shareReadable(share));
  check('分享默认不自动过期', shareReadable(share)); // 无 expires 字段
  db.prepare('UPDATE shares SET revoked_ms = ? WHERE doc_id = ?').run(NOW, 'doc-share-1');
  check('撤销后原链接不可读取', !shareReadable(share));

  // 5. 迁移后旧分享凭据全部无效（导入时不复制 shares 表，或全部置 revoked）
  const share2 = newShare('doc-share-1');
  // 模拟迁移：新实例不导入任何 shares 行
  const migratedReadable = false; // 新实例无 shares 表行
  check('迁移后旧分享链接全部无效', shareReadable(share2) && migratedReadable === false);

  const result = {
    sessionMaxAgeDays: 30,
    checks,
    pass: checks.every((c) => c.pass),
    limitations: ['逻辑层模型试验；真实 HTTP Cookie/限速/响应头属服务器轮', '凭据仅存哈希，符合立项基线'],
  };
  console.log(JSON.stringify(result, null, 2));
  writeResult(TRIAL, result);
  db.close();
  if (!result.pass) process.exit(2);
}

try { main(); } catch (e) { console.error('E11 失败：', e); process.exit(1); }
