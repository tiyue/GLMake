// 清理试验产物：只删除 experiments/work/ 下的全部生成样本、数据库、临时文件和导出包。
// 不删除脚本、文档和 experiments/evidence/。样本可由固定种子重新生成。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORK = path.resolve(HERE, '../work');

if (!WORK.includes('experiments') || !WORK.endsWith('work')) {
  console.error('安全断言失败：拒绝删除非预期目录', WORK);
  process.exit(1);
}
const existed = fs.existsSync(WORK);
fs.rmSync(WORK, { recursive: true, force: true });
console.log(existed ? `已清理 ${WORK}` : '无需清理：work 目录不存在');
console.log('证据目录 experiments/evidence/ 未被触碰。');
