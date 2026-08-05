// 一键执行整轮试验：记录环境信息，逐项运行并保存 run.log 与 result.json
// 用法：node experiments/trials/run-all.mjs [--round 2026-08-06-desktop-r1]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { envInfo } from '../tools/lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

const args = process.argv.slice(2);
const roundIdx = args.indexOf('--round');
const round = roundIdx >= 0 && args[roundIdx + 1] ? args[roundIdx + 1] : 'local';
const evidenceBase = path.join(ROOT, 'experiments', 'evidence', round);
fs.mkdirSync(evidenceBase, { recursive: true });

// 环境信息（含磁盘可用空间，Git Bash 的 df）
const env = envInfo();
const df = spawnSync('df', ['-k', ROOT], { encoding: 'utf8' });
env.diskDf = df.status === 0 ? df.stdout.trim() : df.stderr;
fs.writeFileSync(path.join(evidenceBase, 'env.json'), JSON.stringify(env, null, 2));
console.log(`轮次：${round}`);
console.log(`证据目录：${evidenceBase}`);

const trials = [
  ['E1', 'e1-sqlite-baseline.mjs'],
  ['E2', 'e2-fts-trigram.mjs'],
  ['E3', 'e3-revision-idempotency.mjs'],
  ['E4', 'e4-attachment-pipeline.mjs'],
  ['E5', 'e5-snapshot.mjs'],
  ['E6', 'e6-export-import.mjs'],
];

const summary = [];
for (const [id, file] of trials) {
  console.log(`\n===== ${id} 开始 =====`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(HERE, file)], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GLMAKE_EVIDENCE_DIR: evidenceBase, GLMAKE_ROUND: round },
  });
  const wallMs = Date.now() - t0;
  const log = `exit=${r.status} wallMs=${wallMs}\n\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`;
  fs.mkdirSync(path.join(evidenceBase, id), { recursive: true });
  fs.writeFileSync(path.join(evidenceBase, id, 'run.log'), log);
  const status = r.status === 0 ? 'PASS' : r.status === 2 ? 'FAIL(断言)' : 'FAIL(异常)';
  summary.push({ id, status, wallMs });
  console.log(`===== ${id} 结束：${status}（${wallMs} ms）=====`);
  if (r.status !== 0) console.log(r.stderr.slice(-2000));
}

fs.writeFileSync(path.join(evidenceBase, 'summary.json'), JSON.stringify({ round, env, summary }, null, 2));
console.log('\n汇总：');
for (const s of summary) console.log(`  ${s.id}: ${s.status} (${s.wallMs} ms)`);
const failed = summary.filter((s) => s.status !== 'PASS');
process.exit(failed.length > 0 ? 1 : 0);
