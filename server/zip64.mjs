// 最小 ZIP64 归档实现（store 方法，数据描述符流式写入）
// GLMake 产品代码（自阶段 2 试验轮转正，Apache-2.0）。
import fs from 'node:fs';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOC = 0x07064b50;
const SIG_DESC = 0x08074b50;

// CRC32（IEEE 802.3）
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf, prev = 0) {
  let c = (prev ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(date) {
  return ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff;
}
function dosDate(date) {
  return (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
}

function zip64Extra(size, offset) {
  // 仅在需要时写入对应字段；按 ZIP64 规范顺序：原始大小、压缩大小、偏移
  const fields = [];
  if (size > 0xffffffff) fields.push(BigInt(size));
  if (offset !== undefined && offset > 0xffffffff) fields.push(BigInt(offset));
  if (fields.length === 0) return Buffer.alloc(0);
  const b = Buffer.alloc(4 + 8 * fields.length);
  b.writeUInt16LE(0x0001, 0);
  b.writeUInt16LE(8 * fields.length, 2);
  fields.forEach((v, i) => b.writeBigUInt64LE(v, 4 + i * 8));
  return b;
}

export class ZipWriter {
  constructor(destPath, { fixedDate = new Date(Date.UTC(2026, 7, 6, 0, 0, 0)) } = {}) {
    this.fd = fs.openSync(destPath, 'w');
    this.offset = 0;
    this.entries = [];
    this.date = fixedDate;
  }

  _write(buf) {
    fs.writeSync(this.fd, buf);
    this.offset += buf.length;
  }

  // 流式添加文件：local header 用数据描述符（general flag bit 3），边读边算 CRC
  async addFile(name, srcPath) {
    const nameBuf = Buffer.from(name, 'utf8');
    const localOffset = this.offset;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(SIG_LOCAL, 0);
    header.writeUInt16LE(45, 4); // version needed: 4.5（zip64 能力）
    header.writeUInt16LE(0x0008, 6); // flag: 数据描述符
    header.writeUInt16LE(0, 8); // method: store
    header.writeUInt16LE(dosTime(this.date), 10);
    header.writeUInt16LE(dosDate(this.date), 12);
    // crc/大小未知，置 0，写数据描述符
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);
    this._write(header);
    this._write(nameBuf);

    let crc = 0;
    let size = 0;
    await new Promise((resolve, reject) => {
      const s = fs.createReadStream(srcPath, { highWaterMark: 1024 * 1024 });
      s.on('data', (chunk) => {
        crc = crc32(chunk, crc);
        size += chunk.length;
        fs.writeSync(this.fd, chunk);
        this.offset += chunk.length;
      });
      s.on('end', resolve);
      s.on('error', reject);
    });

    const desc = Buffer.alloc(24);
    desc.writeUInt32LE(SIG_DESC, 0);
    desc.writeUInt32LE(crc >>> 0, 4);
    desc.writeBigUInt64LE(BigInt(size), 8);
    desc.writeBigUInt64LE(BigInt(size), 16);
    this._write(desc);

    this.entries.push({ name, nameBuf, crc: crc >>> 0, size, localOffset });
    return { name, size, crc: crc >>> 0 };
  }

  // 直接添加内存缓冲（清单等小条目）
  addBuffer(name, buf) {
    const nameBuf = Buffer.from(name, 'utf8');
    const localOffset = this.offset;
    const crc = crc32(buf);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(SIG_LOCAL, 0);
    header.writeUInt16LE(45, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(dosTime(this.date), 10);
    header.writeUInt16LE(dosDate(this.date), 12);
    header.writeUInt32LE(crc, 14);
    const big = buf.length > 0xffffffff;
    header.writeUInt32LE(big ? 0xffffffff : buf.length, 18);
    header.writeUInt32LE(big ? 0xffffffff : buf.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    const extra = zip64Extra(buf.length);
    header.writeUInt16LE(extra.length, 28);
    this._write(header);
    this._write(nameBuf);
    if (extra.length) this._write(extra);
    this._write(buf);
    this.entries.push({ name, nameBuf, crc, size: buf.length, localOffset });
    return { name, size: buf.length, crc };
  }

  finish() {
    const centralStart = this.offset;
    for (const e of this.entries) {
      const extra = zip64Extra(e.size, e.localOffset);
      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(SIG_CENTRAL, 0);
      cd.writeUInt16LE(45, 4); // version made by
      cd.writeUInt16LE(45, 6); // version needed
      cd.writeUInt16LE(0x0008, 8); // flag: 数据描述符
      cd.writeUInt16LE(0, 10);
      cd.writeUInt16LE(dosTime(this.date), 12);
      cd.writeUInt16LE(dosDate(this.date), 14);
      cd.writeUInt32LE(e.crc, 16);
      cd.writeUInt32LE(e.size > 0xffffffff ? 0xffffffff : e.size, 20);
      cd.writeUInt32LE(e.size > 0xffffffff ? 0xffffffff : e.size, 24);
      cd.writeUInt16LE(e.nameBuf.length, 28);
      cd.writeUInt16LE(extra.length, 30);
      cd.writeUInt32LE(e.localOffset > 0xffffffff ? 0xffffffff : e.localOffset, 42);
      this._write(cd);
      this._write(e.nameBuf);
      if (extra.length) this._write(extra);
    }
    const centralSize = this.offset - centralStart;
    const need64 = this.entries.length > 0xffff || centralSize > 0xffffffff || centralStart > 0xffffffff;

    if (need64) {
      const e64 = Buffer.alloc(56);
      e64.writeUInt32LE(SIG_EOCD64, 0);
      e64.writeBigUInt64LE(44n, 4);
      e64.writeUInt16LE(45, 12);
      e64.writeUInt16LE(45, 14);
      e64.writeBigUInt64LE(BigInt(this.entries.length), 24);
      e64.writeBigUInt64LE(BigInt(this.entries.length), 32);
      e64.writeBigUInt64LE(BigInt(centralSize), 40);
      e64.writeBigUInt64LE(BigInt(centralStart), 48);
      this._write(e64);
      const loc = Buffer.alloc(20);
      loc.writeUInt32LE(SIG_EOCD64_LOC, 0);
      loc.writeBigUInt64LE(BigInt(centralStart + centralSize), 8);
      this._write(loc);
    }

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(SIG_EOCD, 0);
    eocd.writeUInt16LE(Math.min(this.entries.length, 0xffff), 8);
    eocd.writeUInt16LE(Math.min(this.entries.length, 0xffff), 10);
    eocd.writeUInt32LE(centralSize > 0xffffffff ? 0xffffffff : centralSize, 12);
    eocd.writeUInt32LE(centralStart > 0xffffffff ? 0xffffffff : centralStart, 16);
    this._write(eocd);
    fs.closeSync(this.fd);
    return { entries: this.entries.length, size: this.offset };
  }
}

export class ZipReader {
  constructor(srcPath) {
    this.srcPath = srcPath;
    this.fd = fs.openSync(srcPath, 'r');
    this.fileSize = fs.fstatSync(this.fd).size;
    this._parseCentral();
  }

  _readAt(offset, len) {
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const n = fs.readSync(this.fd, buf, got, len - got, offset + got);
      if (n === 0) throw new Error('意外的文件结尾');
      got += n;
    }
    return buf;
  }

  _parseCentral() {
    // 从尾部找 EOCD
    const tail = this._readAt(Math.max(0, this.fileSize - 65557), Math.min(this.fileSize, 65557));
    let eocdOff = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === SIG_EOCD) { eocdOff = i; break; }
    }
    if (eocdOff < 0) throw new Error('未找到 EOCD');
    const eocdAbs = Math.max(0, this.fileSize - 65557) + eocdOff;
    let count = tail.readUInt16LE(eocdOff + 10);
    let cdSize = tail.readUInt32LE(eocdOff + 12);
    let cdOff = tail.readUInt32LE(eocdOff + 16);

    if (cdOff === 0xffffffff || count === 0xffff) {
      const loc = this._readAt(eocdAbs - 20, 20);
      if (loc.readUInt32LE(0) !== SIG_EOCD64_LOC) throw new Error('缺少 ZIP64 EOCD 定位器');
      const e64Off = Number(loc.readBigUInt64LE(8));
      const e64 = this._readAt(e64Off, 56);
      if (e64.readUInt32LE(0) !== SIG_EOCD64) throw new Error('ZIP64 EOCD 记录损坏');
      count = Number(e64.readBigUInt64LE(32));
      cdSize = Number(e64.readBigUInt64LE(40));
      cdOff = Number(e64.readBigUInt64LE(48));
    }

    const cd = this._readAt(cdOff, cdSize);
    this.entries = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (cd.readUInt32LE(p) !== SIG_CENTRAL) throw new Error('中央目录损坏');
      const flag = cd.readUInt16LE(p + 8);
      const crc = cd.readUInt32LE(p + 16);
      let csize = cd.readUInt32LE(p + 20);
      let usize = cd.readUInt32LE(p + 24);
      const nlen = cd.readUInt16LE(p + 28);
      const elen = cd.readUInt16LE(p + 30);
      let off = cd.readUInt32LE(p + 42);
      const name = cd.subarray(p + 46, p + 46 + nlen).toString('utf8');
      // 解析 ZIP64 扩展字段
      const extra = cd.subarray(p + 46 + nlen, p + 46 + nlen + elen);
      let q = 0;
      let z64size = null, z64off = null;
      while (q + 4 <= extra.length) {
        const id = extra.readUInt16LE(q);
        const sz = extra.readUInt16LE(q + 2);
        if (id === 0x0001) {
          let r = q + 4;
          if (usize === 0xffffffff) { usize = Number(extra.readBigUInt64LE(r)); r += 8; }
          if (csize === 0xffffffff) { csize = Number(extra.readBigUInt64LE(r)); r += 8; }
          if (off === 0xffffffff) { off = Number(extra.readBigUInt64LE(r)); r += 8; }
          z64size = usize; z64off = off;
        }
        q += 4 + sz;
      }
      this.entries.push({ name, flag, crc, size: usize, offset: off });
      p += 46 + nlen + elen;
    }
  }

  // 读取单个条目为 Buffer（校验 CRC；不做路径安全判断，由调用方负责）
  readEntry(entry) {
    const lh = this._readAt(entry.offset, 30);
    if (lh.readUInt32LE(0) !== SIG_LOCAL) throw new Error('本地头损坏');
    const nlen = lh.readUInt16LE(26);
    const elen = lh.readUInt16LE(28);
    const data = this._readAt(entry.offset + 30 + nlen + elen, entry.size);
    if ((entry.flag & 0x0008) === 0 || entry.crc !== 0) {
      const crc = crc32(data);
      if (crc !== entry.crc) throw new Error(`CRC 不一致: ${entry.name}`);
    }
    return data;
  }

  close() { fs.closeSync(this.fd); }
}

// 导入时的路径安全检查：拒绝绝对路径、盘符、反斜杠与路径穿越（纯字符串规则，跨平台）
export function isSafeEntryName(name) {
  if (name.length === 0) return false;
  if (name.includes('\\')) return false;
  if (name.startsWith('/')) return false;
  if (/^[A-Za-z]:/.test(name)) return false;
  const parts = name.split('/');
  if (parts.some((p) => p === '..' || p === '.' || p === '')) return false;
  return true;
}
