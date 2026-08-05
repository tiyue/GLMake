// 固定样本生成器（确定性，固定种子）
// 用法：node experiments/tools/gen-samples.mjs
// 输出：experiments/work/samples/{S0,S1,S2,S3,S4}/ 与 manifest.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mulberry32, sentence, paragraph, mixedBlock,
  padToExactBytes, sha256Stream,
} from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../work/samples');
const BASE_MS = Date.UTC(2026, 6, 1, 0, 0, 0); // 固定基准时间，保证确定性

const SEEDS = { S0: 100, S1: 101, S2: 102, S3: 103, S4: 104 };
const manifest = {
  generator: 'gen-samples.mjs',
  seeds: SEEDS,
  baseTimeMs: BASE_MS,
  units: '十进制字节（1 MB = 1,000,000 B）',
  files: [],
};

function ensure(dir) { fs.mkdirSync(dir, { recursive: true }); }

async function record(relPath, kind, extra = {}) {
  const abs = path.join(ROOT, relPath);
  const { hash, size } = await sha256Stream(abs);
  manifest.files.push({ path: relPath.replaceAll('\\', '/'), size, sha256: hash, kind, ...extra });
}

function writeText(relPath, content) {
  const abs = path.join(ROOT, relPath);
  ensure(path.dirname(abs));
  fs.writeFileSync(abs, content);
}

function writeBuf(relPath, buf) {
  const abs = path.join(ROOT, relPath);
  ensure(path.dirname(abs));
  fs.writeFileSync(abs, buf);
}

// ---------- S0：20 篇文档、4 笔记本、20 标签 ----------
function genS0() {
  const rnd = mulberry32(SEEDS.S0);
  const notebooks = ['笔记本A', '笔记本B', '笔记本C', '笔记本D'];
  const tags = Array.from({ length: 20 }, (_, i) => `标签${String(i + 1).padStart(2, '0')}`);
  const docs = [];
  const longTitle = '这是一个用于验证超长标题显示与排序稳定性的标题'.repeat(4);
  const specs = [
    { title: '空文档样本', body: '' },
    { title: '中文散文样本', body: `# 中文散文样本\n\n${paragraph(rnd, 6)}\n\n${paragraph(rnd, 5)}` },
    { title: 'English sample', body: `# English sample\n\nmarkdown sync revision conflict snapshot backup. ${sentence(rnd)}` },
    { title: '混合标点，样本。；：、', body: `# 混合标点样本\n\n测试，标点。混合；显示：效果、与排序。\n\n${paragraph(rnd, 4)}` },
    { title: longTitle, body: `# ${longTitle}\n\n${paragraph(rnd, 3)}` },
    { title: '中文散文样本', body: `# 中文散文样本（重复标题）\n\n${paragraph(rnd, 4)}` },
    { title: '公式样本', body: `# 公式样本\n\n行内 $E=mc^2$ 与块级：\n\n\\[\n\\sum_{i=1}^{n} x_i = 42\n\\]` },
    { title: '表格样本', body: `# 表格样本\n\n| 列一 | 列二 | 列三 |\n| --- | --- | --- |\n| 甲 | 1 | ${sentence(rnd)} |\n| 乙 | 2 | ${sentence(rnd)} |` },
    { title: '代码样本', body: `# 代码样本\n\n\`\`\`js\nfunction commit(doc, baseRevision) {\n  if (doc.revision !== baseRevision) return { conflict: true };\n  return { revision: doc.revision + 1 };\n}\n\`\`\`` },
    { title: '流程图样本', body: `# 流程图样本\n\n\`\`\`mermaid\ngraph TB\n  A[开始] --> B{冲突?}\n  B -->|是| C[保留双方]\n  B -->|否| D[写入]\n\`\`\`` },
    { title: '时序图样本', body: `# 时序图样本\n\n\`\`\`mermaid\nsequenceDiagram\n  浏览器->>服务器: 提交(base_revision)\n  服务器-->>浏览器: 冲突/成功\n\`\`\`` },
    { title: '复选框样本', body: `# 复选框样本\n\n- [ ] 未完成项一\n- [x] 已完成项一\n- [ ] 未完成项二` },
    { title: '链接样本', body: `# 链接样本\n\n[示例链接](https://example.com/a)、[另一个](https://example.com/b?x=1&y=2)` },
    { title: '图片引用样本', body: `# 图片引用样本\n\n![安全图片](attachments/img.png)\n\n![附件图](attachments/big-a.bin)` },
    { title: '引用样本', body: `# 引用样本\n\n> 一级引用\n> > 二级引用\n>\n> 引用结束` },
    { title: '列表样本', body: `# 列表样本\n\n1. 有序一\n2. 有序二\n   - 嵌套无序\n   - 嵌套无序二\n3. 有序三` },
    { title: '行内代码样本', body: `# 行内代码样本\n\n使用 \`Ctrl+S\` 手动同步，字段 \`change_seq\` 单调递增。` },
    { title: '强调样本', body: `# 强调样本\n\n**加粗**、*斜体*、~~删除线~~、==高亮候选==。` },
    { title: '分隔与脚注样本', body: `# 分隔样本\n\n段落一\n\n---\n\n段落二[^1]\n\n[^1]: 脚注内容。` },
    { title: '综合样本', body: `# 综合样本\n\n${paragraph(rnd, 3)}\n\n${mixedBlock(rnd)}\n${mixedBlock(rnd)}\n${mixedBlock(rnd)}` },
  ];
  const lines = specs.map((s, i) => JSON.stringify({
    doc_id: `s0-d${String(i).padStart(2, '0')}`,
    title: s.title,
    body: s.body,
    notebook: notebooks[i % 4],
    tags: [tags[i % 20], tags[(i * 7 + 3) % 20]],
    updated_ms: BASE_MS + i * 7000,
  }));
  writeText('S0/docs.ndjson', lines.join('\n') + '\n');
  writeText('S0/notebooks.json', JSON.stringify(notebooks, null, 2));
  writeText('S0/tags.json', JSON.stringify(tags, null, 2));
  return { notebooks, tags };
}

// ---------- S1：单篇极限 1/5/10 MB ----------
function genS1() {
  const rnd = mulberry32(SEEDS.S1);
  for (const [name, size] of [['s1-1mb.md', 1_000_000], ['s1-5mb.md', 5_000_000], ['s1-10mb.md', 10_000_000]]) {
    let base = `# ${name}\n\n${paragraph(rnd, 5)}\n`;
    for (let i = 0; i < 8; i++) base += `\n${mixedBlock(rnd)}\n${paragraph(rnd, 4)}\n`;
    writeBuf(`S1/${name}`, padToExactBytes(base, size, rnd));
  }
}

// ---------- S2：1000 篇文档、20 笔记本、100 标签 ----------
function genS2() {
  const rnd = mulberry32(SEEDS.S2);
  const notebooks = Array.from({ length: 20 }, (_, i) => `S2笔记本${String(i + 1).padStart(2, '0')}`);
  const tags = Array.from({ length: 100 }, (_, i) => `S2标签${String(i + 1).padStart(3, '0')}`);
  const lines = [];
  for (let i = 0; i < 1000; i++) {
    const collide = i >= 990; // 排序冲突样本：同标题同更新时间
    const title = collide ? '排序冲突样本' : `S2 文档 ${String(i).padStart(4, '0')} 同步与冲突`;
    let body = `# ${title}\n\n${paragraph(rnd, 3)}\n\n${mixedBlock(rnd)}\n\n文档编号 ${i}，混合内容 2026-08-06 abc-${i}。\n`;
    lines.push(JSON.stringify({
      doc_id: `s2-d${String(i).padStart(4, '0')}`,
      title,
      body,
      notebook: notebooks[i % 20],
      tags: [tags[i % 100], tags[(i * 13 + 5) % 100]],
      updated_ms: collide ? BASE_MS + 7_000_000 : BASE_MS + i * 7000,
    }));
  }
  writeText('S2/docs.ndjson', lines.join('\n') + '\n');
  writeText('S2/notebooks.json', JSON.stringify(notebooks, null, 2));
  writeText('S2/tags.json', JSON.stringify(tags, null, 2));
}

// ---------- S3：正文容量（桌面缩放：10×5MB + 单篇超限样本） ----------
function genS3() {
  const rnd = mulberry32(SEEDS.S3);
  for (let i = 0; i < 10; i++) {
    let base = `# S3 合法文档 ${i}\n\n${paragraph(rnd, 4)}\n`;
    for (let k = 0; k < 4; k++) base += `\n${mixedBlock(rnd)}\n${paragraph(rnd, 4)}\n`;
    writeBuf(`S3/s3-${String(i).padStart(2, '0')}.md`, padToExactBytes(base, 5_000_000, rnd));
  }
  let base = `# S3 单篇超限样本\n\n${paragraph(rnd, 4)}\n`;
  writeBuf('S3/s3-over-doc.md', padToExactBytes(base, 10_000_001, rnd));
}

// ---------- S4：附件边界（桌面缩放） ----------
function prngBlock(rnd, size) {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i += 4) buf.writeUInt32LE(Math.floor(rnd() * 0x100000000), i);
  return buf;
}

function genS4() {
  const rnd = mulberry32(SEEDS.S4);
  const block = prngBlock(rnd, 1_000_000); // 1 MB 确定块，重复拼装
  writeBuf('S4/big-a.bin', Buffer.concat(Array.from({ length: 50 }, () => block)));
  writeBuf('S4/dup-b.bin', Buffer.concat(Array.from({ length: 50 }, () => block))); // 重复二进制
  writeBuf('S4/empty.bin', Buffer.alloc(0));
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), prngBlock(rnd, 1_000_000 - 8)]);
  writeBuf('S4/img.png', png);
  writeText('S4/page.html', '<!doctype html><html><body><script>alert("danger")</script></body></html>');
  writeText('S4/art.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert("danger")</script></svg>');
  writeText('S4/script.js', 'console.log("danger attachment");');
  writeBuf('S4/app.exe', prngBlock(rnd, 2048));
  writeBuf('S4/over.bin', Buffer.concat([Buffer.concat(Array.from({ length: 50 }, () => block)), Buffer.from([0x00])]));
}

// ---------- 主流程 ----------
async function main() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  ensure(ROOT);
  console.log('生成 S0（基础正确性）...'); genS0();
  console.log('生成 S1（单篇极限 1/5/10 MB）...'); genS1();
  console.log('生成 S2（1000 篇文档）...'); genS2();
  console.log('生成 S3（桌面缩放正文容量）...'); genS3();
  console.log('生成 S4（桌面缩放附件边界）...'); genS4();

  console.log('计算 manifest 哈希...');
  for (const rel of ['S0/docs.ndjson', 'S0/notebooks.json', 'S0/tags.json']) await record(rel, 'legal');
  for (const rel of ['S1/s1-1mb.md', 'S1/s1-5mb.md', 'S1/s1-10mb.md']) await record(rel, 'legal');
  await record('S2/docs.ndjson', 'legal');
  await record('S2/notebooks.json', 'legal');
  await record('S2/tags.json', 'legal');
  for (let i = 0; i < 10; i++) await record(`S3/s3-${String(i).padStart(2, '0')}.md`, 'legal');
  await record('S3/s3-over-doc.md', 'oversize', { rule: '单篇正文 > 10,000,000 B' });
  await record('S4/big-a.bin', 'legal');
  await record('S4/dup-b.bin', 'duplicate', { duplicateOf: 'S4/big-a.bin' });
  await record('S4/empty.bin', 'empty');
  await record('S4/img.png', 'safe-image');
  for (const rel of ['S4/page.html', 'S4/art.svg', 'S4/script.js', 'S4/app.exe']) await record(rel, 'danger');
  await record('S4/over.bin', 'oversize', { rule: '单附件 > 50,000,000 B' });

  fs.writeFileSync(path.join(ROOT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const total = manifest.files.reduce((a, f) => a + f.size, 0);
  console.log(`完成：${manifest.files.length} 个样本文件，合计 ${total} B（${(total / 1e6).toFixed(2)} MB）`);
  console.log(`manifest: ${path.join(ROOT, 'manifest.json')}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
