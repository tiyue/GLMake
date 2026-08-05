// 试验公共库：PRNG、确定性文本、哈希、统计、证据输出
// 仅用于阶段 2 技术试验，不是产品代码。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const CN_SENTENCES = [
  '同步服务在断网恢复后应当自动补齐检查，而不是等待下一次定时器触发。',
  '文档标题取自正文中的第一个标题，超长标题需要在列表中稳定截断显示。',
  '回收站保留三十天，超过期限的条目按最旧优先清理。',
  '冲突发生时不得静默覆盖任何一方的内容，必须保留双方版本。',
  '附件按内容哈希寻址，相同二进制只保存一份物理对象。',
  '全量导出包不包含密码哈希、会话或仍然有效的分享凭据。',
  '搜索索引属于可重建的派生数据，索引损坏不等于正文丢失。',
  '历史版本最多保留最近十个，且最长保留三十天。',
  '浏览器本地副本必须能够无损往返，扩展语法不得在保存后丢失。',
  '磁盘水位达到警戒线时，新的写入应当在落盘前被拒绝。',
  '公开分享链接默认不过期，但所有者可以随时撤销。',
  '修订号不可回退，落后的基础修订号必须进入冲突判断。',
  '十进制单位冻结为：一兆字节等于一百万字节。',
  '临时文件在校验长度和哈希之后才允许原子改名。',
  '多窗口编辑同一文档时，后打开的窗口进入只读模式。',
  '永久删除必须给出明确警告，并传播到服务器与其他本地副本。',
  '笔记本与标签通过扩展语法指定，登录后显示服务器中的列表。',
  '导出前必须提示：取得导出包的人可以读取其中全部内容。',
  '会话最长有效期为三十天，退出所有设备必须立即撤销全部会话。',
  '自动同步只在页面打开且联网时运行，无更新时不产生写入。',
];

export const EN_WORDS = [
  'markdown', 'sync', 'revision', 'conflict', 'snapshot', 'backup',
  'attachment', 'notebook', 'tag', 'share', 'session', 'export',
  'import', 'quota', 'tombstone', 'idempotent', 'checksum', 'index',
];

const PUNCT = ['，', '。', '；', '：', '、'];

export function sentence(rnd) {
  if (rnd() < 0.3) {
    const n = 3 + Math.floor(rnd() * 4);
    const parts = [];
    for (let i = 0; i < n; i++) parts.push(EN_WORDS[Math.floor(rnd() * EN_WORDS.length)]);
    return parts.join(' ') + '.';
  }
  return CN_SENTENCES[Math.floor(rnd() * CN_SENTENCES.length)];
}

export function paragraph(rnd, sentences) {
  const out = [];
  for (let i = 0; i < sentences; i++) out.push(sentence(rnd));
  return out.join(PUNCT[Math.floor(rnd() * PUNCT.length)] === '。' ? '' : '') + '';
}

export function mixedBlock(rnd) {
  const kind = Math.floor(rnd() * 5);
  if (kind === 0) {
    const rows = 2 + Math.floor(rnd() * 3);
    let t = '| 编号 | 名称 | 说明 |\n| --- | --- | --- |\n';
    for (let i = 0; i < rows; i++) t += `| ${i + 1} | item-${i} | ${sentence(rnd)} |\n`;
    return t;
  }
  if (kind === 1) {
    return '```js\nfunction sync(doc) {\n  // ' + sentence(rnd) + '\n  return doc.revision + 1;\n}\n```\n';
  }
  if (kind === 2) {
    return '行内公式 $E=mc^2$ 与块级公式：\n\n\\[\n\\sum_{i=1}^{n} x_i = ' + Math.floor(rnd() * 1000) + '\n\\]\n';
  }
  if (kind === 3) {
    return '```mermaid\ngraph TB\n  A[编辑] --> B[本地保存]\n  B --> C{同步}\n  C -->|成功| D[服务器]\n  C -->|冲突| E[保留双方]\n```\n';
  }
  return '- [ ] ' + sentence(rnd) + '\n- [x] ' + sentence(rnd) + '\n- 链接：[示例](https://example.com/' + Math.floor(rnd() * 10000) + ')\n';
}

// 将内容填充到精确的 targetBytes 字节（真实文本填充 + UTF-8 安全截断 + 空格补齐）
export function padToExactBytes(base, targetBytes, rnd) {
  let content = base;
  while (Buffer.byteLength(content, 'utf8') < targetBytes) {
    content += '\n\n' + paragraph(rnd, 4 + Math.floor(rnd() * 4)) + '\n\n' + mixedBlock(rnd);
  }
  let buf = Buffer.from(content, 'utf8');
  if (buf.length > targetBytes) {
    buf = buf.subarray(0, targetBytes);
    // 去掉被截断的不完整 UTF-8 尾字节
    let end = buf.length;
    while (end > 0 && (buf[end - 1] & 0xc0) === 0x80) end--;
    if (end > 0 && end < buf.length) {
      const lead = buf[end - 1];
      const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
      if (buf.length - end + 1 < need) buf = buf.subarray(0, end - 1);
      else buf = buf.subarray(0, buf.length);
    }
  }
  const pad = targetBytes - buf.length;
  return Buffer.concat([buf, Buffer.from(' '.repeat(pad), 'ascii')]);
}

export function sha256Stream(srcPath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(srcPath);
    let size = 0;
    s.on('data', (c) => { h.update(c); size += c.length; });
    s.on('end', () => resolve({ hash: h.digest('hex'), size }));
    s.on('error', reject);
  });
}

export function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function quantile(sortedArr, q) {
  if (sortedArr.length === 0) return null;
  const idx = Math.min(sortedArr.length - 1, Math.floor(q * sortedArr.length));
  return sortedArr[idx];
}

export function envInfo() {
  return {
    time: new Date().toISOString(),
    platform: `${os.type()} ${os.release()} ${os.arch()}`,
    node: process.version,
    cpus: os.cpus()[0]?.model,
    cpuCount: os.cpus().length,
    totalMemBytes: os.totalmem(),
    freeMemBytes: os.freemem(),
    note: '桌面预检轮：非目标服务器，结果仅为观察级',
  };
}

export function evidenceDir(trialId) {
  const round = process.env.GLMAKE_ROUND || 'local';
  const base = process.env.GLMAKE_EVIDENCE_DIR;
  const dir = base
    ? path.join(base, trialId)
    : path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../evidence', round, trialId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeResult(trialId, result) {
  const dir = evidenceDir(trialId);
  const merged = { trial: trialId, env: envInfo(), ...result };
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(merged, null, 2));
  const hashes = result._hashes;
  if (hashes && Object.keys(hashes).length > 0) {
    const lines = Object.entries(hashes).map(([k, v]) => `${v}  ${k}`);
    fs.writeFileSync(path.join(dir, 'hashes.txt'), lines.join('\n') + '\n');
  }
  return dir;
}

export function fmtBytes(n) {
  return `${n} B (${(n / 1e6).toFixed(2)} MB)`;
}
