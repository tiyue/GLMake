// E4 附件不可变对象管线
// 假设：临时写→哈希校验→fsync→原子改名全程无半成品残留；同内容文件只存一个对象；
// 超限文件在正式对象落盘前被拒绝。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeResult } from '../tools/lib.mjs';
import { readManifest, WORK, SAMPLES } from '../tools/dbsetup.mjs';

const TRIAL = 'E4';
const STORE = path.join(WORK, 'store');
const TMP = path.join(STORE, 'tmp');
const OBJECTS = path.join(STORE, 'objects');
const MAX_ATTACHMENT = 50_000_000; // 十进制

// 流式接收附件：边写临时文件边累计大小与哈希；超限立即中止并清理
function storeAttachment(srcPath, maxSize) {
  const tmpName = path.join(TMP, `upload-${crypto.randomBytes(8).toString('hex')}.part`);
  const fd = fs.openSync(tmpName, 'w');
  const h = crypto.createHash('sha256');
  let size = 0;
  let rejected = false;
  const chunks = fs.readFileSync(srcPath, { flag: 'r' }); // 简单起见整读；流式校验逻辑如下
  // 分块模拟网络接收
  const CHUNK = 1024 * 1024;
  try {
    for (let off = 0; off < chunks.length; off += CHUNK) {
      const c = chunks.subarray(off, Math.min(off + CHUNK, chunks.length));
      size += c.length;
      if (size > maxSize) { rejected = true; break; }
      h.update(c);
      fs.writeSync(fd, c);
    }
    if (rejected) return { rejected: true, reason: 'size_exceeded', observedBytes: size };
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    const hash = h.digest('hex');
    const objDir = path.join(OBJECTS, hash.slice(0, 2));
    fs.mkdirSync(objDir, { recursive: true });
    const objPath = path.join(objDir, hash);
    if (fs.existsSync(objPath)) {
      // 去重：对象已存在，丢弃临时文件
      fs.rmSync(tmpName);
      return { deduped: true, hash, size };
    }
    fs.renameSync(tmpName, objPath);
    return { stored: true, hash, size, objectPath: objPath };
  } finally {
    try { fs.closeSync(fd); } catch { /* 已关闭 */ }
    if (rejected) { try { fs.rmSync(tmpName); } catch { /* 忽略 */ } }
  }
}

function listObjects() {
  const out = [];
  if (!fs.existsSync(OBJECTS)) return out;
  for (const d of fs.readdirSync(OBJECTS)) {
    for (const f of fs.readdirSync(path.join(OBJECTS, d))) out.push(path.join(OBJECTS, d, f));
  }
  return out;
}

function main() {
  fs.rmSync(STORE, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  fs.mkdirSync(OBJECTS, { recursive: true });

  const manifest = readManifest();
  const byPath = Object.fromEntries(manifest.files.map((f) => [f.path, f]));
  const checks = [];
  const check = (name, cond, detail = '') => checks.push({ name, pass: !!cond, detail });

  const cases = [
    { path: 'S4/big-a.bin', maxSize: MAX_ATTACHMENT },
    { path: 'S4/dup-b.bin', maxSize: MAX_ATTACHMENT },
    { path: 'S4/empty.bin', maxSize: MAX_ATTACHMENT },
    { path: 'S4/img.png', maxSize: MAX_ATTACHMENT },
    { path: 'S4/page.html', maxSize: MAX_ATTACHMENT },
    { path: 'S4/art.svg', maxSize: MAX_ATTACHMENT },
    { path: 'S4/script.js', maxSize: MAX_ATTACHMENT },
    { path: 'S4/app.exe', maxSize: MAX_ATTACHMENT },
  ];
  const results = {};
  for (const c of cases) results[c.path] = storeAttachment(path.join(SAMPLES, c.path), c.maxSize);

  // 1. 合法附件全部落盘且哈希与 manifest 一致
  for (const c of cases) {
    const r = results[c.path];
    const m = byPath[c.path];
    const expectHash = c.path === 'S4/dup-b.bin' ? byPath['S4/big-a.bin'].sha256 : m.sha256;
    const ok = (r.stored || r.deduped) && r.hash === expectHash && r.size === m.size;
    check(`${c.path} 哈希与大小一致`, ok, `hash=${r.hash?.slice(0, 12)} size=${r.size}`);
  }

  // 2. 去重：dup-b 与 big-a 同哈希，物理对象只有一个
  check('重复二进制命中去重', results['S4/dup-b.bin'].deduped === true);
  const bigHash = byPath['S4/big-a.bin'].sha256;
  const bigObjPath = path.join(OBJECTS, bigHash.slice(0, 2), bigHash);
  check('同内容只存一个物理对象', fs.existsSync(bigObjPath) && results['S4/dup-b.bin'].hash === bigHash);

  // 3. 超限：over.bin（50,000,001 B）在正式对象落盘前被拒绝
  const over = storeAttachment(path.join(SAMPLES, 'S4/over.bin'), MAX_ATTACHMENT);
  const overHash = byPath['S4/over.bin'].sha256;
  const overObjPath = path.join(OBJECTS, overHash.slice(0, 2), overHash);
  check('超限附件被拒绝', over.rejected === true && over.observedBytes > MAX_ATTACHMENT);
  check('超限附件无正式对象', !fs.existsSync(overObjPath));

  // 4. 临时目录无残留（无半成品）
  const tmpLeft = fs.readdirSync(TMP);
  check('临时目录无残留', tmpLeft.length === 0, `残留=${JSON.stringify(tmpLeft)}`);

  // 5. 对象总数核对：8 个输入 → 7 个物理对象（去重一次）
  const objs = listObjects();
  check('物理对象数量为 7', objs.length === 7, `实际=${objs.length}`);

  // 6. 对象内容抽查：读回后重新计算哈希
  const readBack = fs.readFileSync(bigObjPath);
  const readHash = crypto.createHash('sha256').update(readBack).digest('hex');
  check('对象读回哈希一致', readHash === bigHash);

  const result = {
    maxAttachmentBytes: MAX_ATTACHMENT,
    perCase: results,
    oversize: over,
    objectCount: objs.length,
    checks,
    pass: checks.every((c) => c.pass),
    limitations: ['桌面缩放样本（总量约 101 MB）；500 MB 全量属服务器轮'],
  };
  console.log(JSON.stringify(result, null, 2));
  writeResult(TRIAL, result);
  if (!result.pass) process.exit(2);
}

try { main(); } catch (e) { console.error('E4 失败：', e); process.exit(1); }
