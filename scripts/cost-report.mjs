// 花费日报：按北京时间"天 × 会话"统计 token 花费（账本去重后计算，元）。
//
// 为什么要这个：控制台的 /api/tokens/summary 是**会话生命周期累计**，看不出"今天花了多少"；
// /api/tokens/series 是按小时。想回答"昨天花了多少钱、谁花的、哪一小时最贵"就得按天切。
//
// 用法：
//   node scripts/cost-report.mjs              # 最近 7 天
//   node scripts/cost-report.mjs --days 3
//   node scripts/cost-report.mjs --hours       # 额外打印最近 24 小时逐小时
// 只读：只读 state/token-usage.jsonl，不碰网络。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beijingParts, priceUsage, resolvePriceTable } from '../src/model-prices.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'state', 'token-usage.jsonl');

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const days = Math.max(1, Number(arg('--days', 7)) || 7);
const withHours = argv.includes('--hours');

const table = resolvePriceTable(null);

// 账本按 (sessionId, turn, step, retry) 幂等：快照重连会重发历史采样，必须"后到覆盖先到"。
const samples = new Map();
for (const line of fs.readFileSync(FILE, 'utf8').split(/\r?\n/)) {
  if (!line.trim()) continue;
  let j;
  try { j = JSON.parse(line); } catch { continue; }
  if (j.k !== 'turn') continue;
  samples.set([j.sid, j.turn, j.step, j.retry].join('|'), j);
}

const byDay = new Map();      // date -> { cost, turns:Set, tokens }
const byDayKey = new Map();   // `${date} ${key}` -> cost
const byHour = new Map();     // `${date} ${HH}` -> cost
for (const j of samples.values()) {
  const at = Number(j.t);
  const { date, hour } = beijingParts(at);
  const buckets = {
    cacheMiss: Number(j.b?.cacheMiss) || 0,
    cacheHit: Number(j.b?.cacheHit) || 0,
    cacheWrite: Number(j.b?.cacheWrite) || 0,
    output: Number(j.b?.output) || 0,
    reasoning: Number(j.b?.reasoning) || 0
  };
  // 注意：priceUsage().cost 是**分项对象**（costOfBuckets 的返回），不是数字。
  const cost = priceUsage(buckets, { model: j.model || 'deepseek-flash', at, table }).cost.total;
  const day = byDay.get(date) ?? { cost: 0, tokens: 0, turns: new Set() };
  day.cost += cost;
  day.tokens += buckets.cacheMiss + buckets.cacheHit + buckets.cacheWrite + buckets.output;
  day.turns.add(`${j.sid}|${j.turn}`);
  byDay.set(date, day);
  byDayKey.set(`${date} ${j.key}`, (byDayKey.get(`${date} ${j.key}`) ?? 0) + cost);
  const h = `${date} ${String(hour).padStart(2, '0')}`;
  byHour.set(h, (byHour.get(h) ?? 0) + cost);
}

const dates = [...byDay.keys()].sort().slice(-days);
const money = (n) => `¥${n.toFixed(2)}`;
console.log(`价格表：${table.models['deepseek-flash'].label}  空闲 命中¥0.02/M 未命中¥1/M 输出¥4/M（高峰×${table.peakMultiplier}：${table.peakWindows.map(([a, b]) => `${a}-${b}点`).join('、')} 工作日）\n`);
for (const d of dates) {
  const day = byDay.get(d);
  console.log(`=== ${d}  ${money(day.cost)}  回合 ${day.turns.size}  token ${(day.tokens / 1e6).toFixed(1)}M  均 ${money(day.cost / Math.max(1, day.turns.size))}/回合`);
  const rows = [...byDayKey.entries()].filter(([k]) => k.startsWith(`${d} `)).sort((a, b) => b[1] - a[1]);
  for (const [k, c] of rows) {
    if (c < 0.005) continue;
    const share = ((c / day.cost) * 100).toFixed(0).padStart(3);
    console.log(`    ${k.slice(11).padEnd(22)} ${money(c).padStart(8)}  ${share}%`);
  }
}
if (withHours) {
  const today = dates[dates.length - 1];
  console.log(`\n=== ${today} 逐小时 ===`);
  for (const [h, c] of [...byHour.entries()].filter(([k]) => k.startsWith(`${today} `)).sort()) {
    if (c < 0.005) continue;
    console.log(`    ${h.slice(11)}:00  ${money(c).padStart(7)}  ${'█'.repeat(Math.min(40, Math.round(c * 8)))}`);
  }
}
