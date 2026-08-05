// E6 全量导出/导入往返
// 假设：ZIP64 流式导出后导入到干净目录，全部哈希与数量核对一致；路径穿越条目被拒绝；
// 独立工具（Python zipfile）可读取同一归档。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeResult, sha256Stream, sha256Buffer } from '../tools/lib.mjs';
import { readNdjson, readManifest, WORK, SAMPLES } from '../tools/dbsetup.mjs';
import { ZipWriter, ZipReader, isSafeEntryName } from '../tools/zip64.mjs';

const TRIAL = 'E6';
const EXPORT_DIR = path.join(WORK, 'export');
const ZIP_PATH = path.join(EXPORT_DIR, 'trial.glmake.zip');
const IMPORT_DIR = path.join(WORK, 'import-clean');
const ATTACK_ZIP = path.join(EXPORT_DIR, 'attack.zip');
const ATTACK_DIR = path.join(WORK, 'import-attack');

const checks = [];
const check = (name, cond, detail = '') => checks.push({ name, pass: !!cond, detail });

async function buildExportZip() {
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  fs.rmSync(ZIP_PATH, { force: true });
  const zw = new ZipWriter(ZIP_PATH);

  const docs = readNdjson('S0/docs.ndjson');
  const manifest = readManifest();
  const atts = manifest.files.filter((f) => f.path.startsWith('S4/') && f.kind !== 'oversize');

  const exportManifest = {
    format: 'glmake-export',
    format_version: 1,
    app_version: 'trial-0.1',
    exported_at: new Date().toISOString(),
    documents: [],
    attachments: [],
  };

  // 文档正文条目（逐篇流式写入，不整体载入内存）
  const docTmpDir = path.join(EXPORT_DIR, 'docs-tmp');
  fs.mkdirSync(docTmpDir, { recursive: true });
  for (const d of docs) {
    const tmp = path.join(docTmpDir, `${d.doc_id}.md`);
    fs.writeFileSync(tmp, d.body);
    await zw.addFile(`documents/${d.doc_id}.md`, tmp);
    exportManifest.documents.push({ doc_id: d.doc_id, title: d.title, notebook: d.notebook, tags: d.tags, path: `documents/${d.doc_id}.md`, sha256: sha256Buffer(Buffer.from(d.body)), size: Buffer.byteLength(d.body) });
    fs.rmSync(tmp);
  }
  // 附件条目（流式）
  for (const a of atts) {
    await zw.addFile(`attachments/${a.sha256}`, path.join(SAMPLES, a.path));
    exportManifest.attachments.push({ hash: a.sha256, size: a.size, orig_name: path.basename(a.path), path: `attachments/${a.sha256}` });
  }
  zw.addBuffer('manifest.json', Buffer.from(JSON.stringify(exportManifest, null, 2)));
  const fin = zw.finish();
  return { fin, docCount: docs.length, attCount: atts.length };
}

function importZip(zipPath, destDir) {
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  const zr = new ZipReader(zipPath);
  // 先全量安全检查，再落盘：任何不安全条目导致整包拒绝
  for (const e of zr.entries) {
    if (!isSafeEntryName(e.name)) {
      zr.close();
      throw new Error(`不安全条目被拒绝：${e.name}`);
    }
  }
  let files = 0;
  for (const e of zr.entries) {
    const data = zr.readEntry(e);
    const target = path.join(destDir, e.name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    files++;
  }
  zr.close();
  return files;
}

async function main() {
  // 1. 导出
  const { fin, docCount, attCount } = await buildExportZip();
  const zipHash = await sha256Stream(ZIP_PATH);
  check('导出包生成成功', fin.entries === docCount + attCount + 1, `entries=${fin.entries}`);

  // 2. 导入到干净目录
  const extracted = importZip(ZIP_PATH, IMPORT_DIR);
  check('导入条目数量一致', extracted === fin.entries, `extracted=${extracted}`);

  // 3. 哈希与数量核对
  const im = JSON.parse(fs.readFileSync(path.join(IMPORT_DIR, 'manifest.json'), 'utf8'));
  let docHashOk = true;
  const srcDocs = readNdjson('S0/docs.ndjson');
  const srcBydId = Object.fromEntries(srcDocs.map((d) => [d.doc_id, d]));
  for (const d of im.documents) {
    const got = fs.readFileSync(path.join(IMPORT_DIR, d.path), 'utf8');
    if (got !== srcBydId[d.doc_id].body) { docHashOk = false; break; }
  }
  check('全部文档正文逐字节一致', docHashOk && im.documents.length === docCount);
  let attHashOk = true;
  for (const a of im.attachments) {
    const { hash, size } = await sha256Stream(path.join(IMPORT_DIR, a.path));
    if (hash !== a.hash || size !== a.size) { attHashOk = false; break; }
  }
  check('全部附件哈希与大小一致', attHashOk && im.attachments.length === attCount);
  check('不含密码/会话/分享凭据字段', !JSON.stringify(im).match(/password|session|token|secret/i));

  // 4. 路径穿越攻击包必须被整包拒绝，且不落盘任何文件
  const azw = new ZipWriter(ATTACK_ZIP);
  azw.addBuffer('documents/ok.md', Buffer.from('# ok'));
  azw.addBuffer('../evil.md', Buffer.from('evil'));
  azw.finish();
  let attackRejected = false;
  let attackErr = '';
  try {
    importZip(ATTACK_ZIP, ATTACK_DIR);
  } catch (e) {
    attackRejected = true;
    attackErr = e.message;
  }
  const attackLeftover = fs.existsSync(ATTACK_DIR) ? fs.readdirSync(ATTACK_DIR) : [];
  check('路径穿越条目被拒绝', attackRejected, attackErr);
  check('攻击包未落盘任何文件', attackLeftover.length === 0, JSON.stringify(attackLeftover));

  // 5. Python zipfile 独立交叉验证
  const pyScript = `
import hashlib, json, sys, zipfile
zp = sys.argv[1]; expect_hash = sys.argv[2]
z = zipfile.ZipFile(zp)
bad = z.testzip()
names = z.namelist()
att = [n for n in names if n.startswith('attachments/')][0]
data = z.read(att)
print(json.dumps({'testzip_bad': bad, 'count': len(names), 'entry_hash': hashlib.sha256(data).hexdigest(), 'entry': att}))
`;
  const bigHash = readManifest().files.find((f) => f.path === 'S4/big-a.bin').sha256;
  const py = spawnSync('python', ['-c', pyScript, ZIP_PATH, bigHash], { encoding: 'utf8' });
  let pyOk = false;
  let pyOut = null;
  if (py.status === 0) {
    try {
      pyOut = JSON.parse(py.stdout.trim());
      pyOk = pyOut.testzip_bad === null && pyOut.count === fin.entries && pyOut.entry_hash === bigHash;
    } catch { /* 解析失败 */ }
  } else {
    pyOut = { stderr: py.stderr };
  }
  check('Python zipfile 交叉读取一致', pyOk, JSON.stringify(pyOut));

  const result = {
    zipEntries: fin.entries,
    zipBytes: fin.size,
    documents: docCount,
    attachments: attCount,
    pythonCrossCheck: pyOut,
    checks,
    pass: checks.every((c) => c.pass),
    _hashes: { 'trial.glmake.zip': zipHash.hash },
    limitations: [
      '桌面缩放：导出包约 101 MB；接近 500 MB 与 12 GB 上限的迁移演练属服务器轮',
      'ZIP64 大于 4 GB 条目的代码路径已实现但未实测（桌面轮无法产生该规模数据）',
      'HTTP Range 续传下载属服务端交付方式，本轮不涉及',
    ],
  };
  console.log(JSON.stringify(result, null, 2));
  writeResult(TRIAL, result);
  if (!result.pass) process.exit(2);
}

main().catch((e) => { console.error('E6 失败：', e); process.exit(1); });
