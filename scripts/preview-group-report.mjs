// 干跑预览：把某个群某一天的活跃日报**打印出来**，不发送任何 QQ 消息。
//
// 用途：调格式、验证数据源、排查"为什么今天没发"。
//
//   node scripts/preview-group-report.mjs                  # 用配置里的群 + 覆盖日（默认昨天）
//   node scripts/preview-group-report.mjs --date 2026-10-02
//   node scripts/preview-group-report.mjs --group 9000000012 --top 15
//   node scripts/preview-group-report.mjs --json           # 打印原始统计对象
//   node scripts/preview-group-report.mjs --db "<SnowLuma-data>/messages.db"
//
// 只读：绝不会写 config.json / state/，也绝不会调用 OneBot。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_REPORT_AT,
  collectDailyStats,
  dateLabel,
  decideReportAction,
  formatDailyReport,
  localDateKey,
  lookupMemberNamesFromDb,
  normalizeReportGroupIds,
  parseReportAt,
  pickMessagesDb,
  resolveMessagesDbCandidates,
  shiftDateKey
} from '../src/group-stats.js';
import { collectMuteStats, formatMuteKingSection } from '../src/mute-stats.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = { group: '', date: '', top: null, json: false, db: '', help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--json') out.json = true;
    else if (a === '--group') out.group = argv[++i] ?? '';
    else if (a === '--date') out.date = argv[++i] ?? '';
    else if (a === '--top') out.top = Number(argv[++i]);
    else if (a === '--db') out.db = argv[++i] ?? '';
    else throw new Error(`未知参数：${a}（用 --help 看用法）`);
  }
  return out;
}

function readConfig() {
  try {
    const raw = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

const HELP = `群活跃日报 · 干跑预览（不发送）

用法：node scripts/preview-group-report.mjs [选项]

  --group <群号>   目标群，默认取 config.json 的 groupStats.groupIds[0] / groupId，再退回 allow.groups[0]
  --date <日期>    统计哪一天（YYYY-MM-DD），默认按 reportAt/coverDay 推算"刚结束的那一天"
  --top <人数>     活跃榜人数上限，默认取 config.json 的 groupStats.leaderboardSize（10）
  --db <路径>      指定 SnowLuma messages.db，默认自动发现（groupStats.dbPath → snowluma.homeDir/data/*）
  --json           打印原始统计对象而不是渲染后的文本
  -h, --help       显示本帮助
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); return; }

  const cfg = readConfig();
  const gs = cfg.groupStats ?? {};
  const groupId = Number(args.group || normalizeReportGroupIds({ groupId: gs.groupId, groupIds: gs.groupIds })[0] || cfg.allow?.groups?.[0] || 0);
  if (!Number.isSafeInteger(groupId) || groupId <= 0) {
    throw new Error('没有可用的目标群：请用 --group 指定，或在 config.json 里配 allow.groups / groupStats.groupIds');
  }

  const reportAt = String(gs.reportAt || DEFAULT_REPORT_AT);
  if (!parseReportAt(reportAt)) throw new Error(`config.json 的 groupStats.reportAt 不是合法 HH:MM：「${reportAt}」`);

  // 默认日期 = 按同一套调度规则算出的"该发的那一天"，保证预览与线上发的完全一致。
  let dateKey = String(args.date || '').trim();
  if (!dateKey) {
    const decision = decideReportAction({ reportAt, coverDay: gs.coverDay || 'auto', schedule: {}, catchUpHours: 24 * 365 });
    dateKey = decision.coveredDateKey ?? shiftDateKey(localDateKey(), -1);
  }

  const explicit = String(args.db || gs.dbPath || '').trim();
  const homeDir = String(cfg.snowluma?.homeDir || '').trim();
  const candidates = resolveMessagesDbCandidates({ explicit, homeDir });
  if (candidates.length === 0) {
    throw new Error(explicit
      ? `指定的消息库不存在：${explicit}`
      : `没找到 SnowLuma 消息库。请检查 config.json 的 snowluma.homeDir（当前「${homeDir}」），或用 --db 指定。`);
  }
  const dbPath = candidates.length === 1 ? candidates[0] : await pickMessagesDb({ candidates });

  const top = Number.isFinite(args.top) && args.top > 0 ? args.top : Number(gs.leaderboardSize) || 10;
  const excludeSelf = gs.excludeSelf !== false;

  console.log(`消息库: ${dbPath}`);
  console.log(`群号:   ${groupId}   日期: ${dateKey}（${dateLabel(dateKey)}）\n`);

  const stats = await collectDailyStats({ dbPath, groupId, dateKey, excludeSelf });
  let prevTotal = null;
  try {
    const prev = await collectDailyStats({ dbPath, groupId, dateKey: shiftDateKey(dateKey, -1), excludeSelf });
    prevTotal = prev.total;
  } catch { /* 前一天查不到就不显示环比 */ }

  // 「禁言王」小节必须与线上一致 —— 预览和实际发的内容不一致，预览就没意义了。
  // 口径见 src/mute-stats.js：只算**经由本机器人成功执行**的禁言。
  let muteKingLines = [];
  if (gs.muteKingEnabled !== false) {
    const mk = collectMuteStats({
      logPath: path.join(ROOT, 'state', 'group-admin.log'),
      dateKey,
      groupId
    });
    if (mk.total > 0) {
      // 与线上同一套优先级（见 src/bridge.js 里的同名逻辑），只是这里没有 OneBot 可用，
      // 所以少最后一层"群成员表"。**任何一层都不回落到 QQ 号** ——
      // 都取不到时由 src/mute-stats.js 兜底成「某位群友」。
      const byId = new Map(stats.members.map((m) => [String(m.userId), String(m.name)]));
      const ids = [...new Set([...mk.muted, ...mk.mutedBy].map((e) => String(e.id)))];
      const need = ids.filter((id) => !byId.has(id));
      let dbNames = new Map();
      if (need.length) {
        try {
          dbNames = await lookupMemberNamesFromDb({ dbPath, groupId, userIds: need });
        } catch { /* 补查失败不致命 */ }
      }
      muteKingLines = formatMuteKingSection({
        muted: mk.muted,
        mutedBy: mk.mutedBy,
        resolveName: (id) => byId.get(String(id)) || dbNames.get(String(id)) || '',
        size: Number(gs.muteKingSize) > 0 ? Number(gs.muteKingSize) : 5
      });
    }
  }

  if (args.json) {
    console.log(JSON.stringify({ ...stats, prevTotal, muteKingLines }, null, 2));
    return;
  }
  if (!stats.groupName) console.log(`（库里没有该群的 group_name，日报将退回用群号显示）\n`);
  console.log(formatDailyReport({ stats, prevTotal, leaderboardSize: top, maxChars: Number(gs.maxChars) || 900, muteKingLines }));
  console.log(`\n字符数: ${formatDailyReport({ stats, prevTotal, leaderboardSize: top, maxChars: Number(gs.maxChars) || 900, muteKingLines }).length}`);
}

main().catch((error) => {
  console.error(`❌ ${error?.message ?? error}`);
  process.exitCode = 1;
});
