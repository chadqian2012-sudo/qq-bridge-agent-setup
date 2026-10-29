// 把「近 N 分钟群活跃」即时打印到群里。
//
// 与日报的分工：日报是**按自然日**的定时汇总（00:00 发前一天），
// 这个是**任意时间窗**的即时查询——想看"刚才这一阵谁在说话"时用。
// 两者共用 src/group-stats.js 的同一份聚合口径（countRange → aggregateGroupRows）。
//
//   node scripts/send-active-window.mjs                    # 近 10 分钟，真的发
//   node scripts/send-active-window.mjs --minutes 30       # 近 30 分钟
//   node scripts/send-active-window.mjs --minutes 10 -n    # 只打印，不发送
//
// 安全边界与其它发送脚本一致：目标群必须命中 config.json 的 allow.groups；
// 发送前过敏感信息正则脱敏；走 OneBot HTTP（不依赖桥接进程，也不写任何 state/）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SENSITIVE_RE } from '../src/sensitive.js';
import {
  collectWindowStats,
  formatWindowReport,
  normalizeReportGroupIds,
  pickMessagesDb,
  resolveMessagesDbCandidates
} from '../src/group-stats.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = { minutes: 10, group: '', top: 8, db: '', dryRun: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--dry-run' || a === '-n') out.dryRun = true;
    else if (a === '--minutes' || a === '-m') out.minutes = Number(argv[++i]);
    else if (a === '--group' || a === '-g') out.group = argv[++i] ?? '';
    else if (a === '--top' || a === '-t') out.top = Number(argv[++i]);
    else if (a === '--db') out.db = argv[++i] ?? '';
    else throw new Error(`未知参数：${a}（用 --help 看用法）`);
  }
  return out;
}

const HELP = `群活跃 · 近 N 分钟即时报告（会真的发到群里）

用法：node scripts/send-active-window.mjs [选项]

  --minutes, -m <分钟>  统计窗口长度，默认 10
  --group,   -g <群号>  目标群，默认取 config.json 的 groupStats.groupIds[0] / groupId
  --top,     -t <人数>  榜单人数上限，默认 8
  --db <路径>           指定 SnowLuma messages.db，默认自动发现
  --dry-run, -n         只打印将要发送的内容，不真的发
  -h, --help            显示本帮助
`;

function redact(text) {
  const flags = SENSITIVE_RE.flags.includes('g') ? SENSITIVE_RE.flags : SENSITIVE_RE.flags + 'g';
  return String(text ?? '').replace(new RegExp(SENSITIVE_RE.source, flags), '***');
}
const escapeCqText = (t) => String(t ?? '').replace(/\[CQ:/gi, '[CQ：');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); return; }
  if (!Number.isFinite(args.minutes) || args.minutes <= 0) throw new Error(`--minutes 必须是正数，收到「${args.minutes}」`);

  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
  const gs = cfg.groupStats ?? {};
  const groupId = Number(args.group || normalizeReportGroupIds({ groupId: gs.groupId, groupIds: gs.groupIds })[0] || 0);
  if (!Number.isSafeInteger(groupId) || groupId <= 0) {
    throw new Error('没有可用的目标群：请用 --group 指定，或在 config.json 里配 groupStats.groupIds');
  }

  const allowGroups = (cfg.allow?.groups ?? []).map(String);
  if (!allowGroups.includes(String(groupId))) {
    throw new Error(`群 ${groupId} 不在 config.json 的 allow.groups（${allowGroups.join(', ') || '空'}）内，拒绝发送`);
  }

  const explicit = String(args.db || gs.dbPath || '').trim();
  const candidates = resolveMessagesDbCandidates({ explicit, homeDir: cfg.snowluma?.homeDir });
  if (candidates.length === 0) throw new Error('没找到 SnowLuma 消息库（检查 snowluma.homeDir 或用 --db 指定）');
  const dbPath = candidates.length === 1 ? candidates[0] : await pickMessagesDb({ candidates });

  const stats = await collectWindowStats({
    dbPath,
    groupId,
    windowMinutes: args.minutes,
    excludeSelf: gs.excludeSelf !== false
  });
  const text = redact(formatWindowReport({
    stats,
    topN: Number.isFinite(args.top) && args.top > 0 ? args.top : 8,
    maxChars: Number(gs.maxChars) || 600
  }));

  console.log(`群:     ${groupId}${stats.groupName ? `（${stats.groupName}）` : ''}`);
  console.log(`窗口:   近 ${args.minutes} 分钟（${new Date(stats.startSec * 1000).toLocaleTimeString('zh-CN', { hour12: false })} → 现在）`);
  console.log(`数据:   ${stats.total} 条 / ${stats.activeMembers} 人\n`);
  console.log('──────── 将要发送 ────────');
  console.log(text);
  console.log('──────────────────────────');

  if (args.dryRun) { console.log('\n（--dry-run：未发送）'); return; }

  const base = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const res = await fetch(`${base}/send_group_msg`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
    },
    body: JSON.stringify({ group_id: groupId, message: [{ type: 'text', data: { text: escapeCqText(text) } }] }),
    signal: AbortSignal.timeout(15000)
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
    throw new Error(`OneBot send_group_msg 失败: HTTP ${res.status} ${body.wording ?? body.retcode ?? ''}`);
  }
  console.log(`\n✅ 已发送到群 ${groupId}（message_id=${body.data?.message_id ?? '?'}）`);
}

main().catch((error) => {
  console.error(`❌ ${error?.message ?? error}`);
  process.exitCode = 1;
});
