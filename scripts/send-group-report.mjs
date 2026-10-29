// 手动把某个群某一天的活跃日报**真的发到群里**。
//
// 用途：试发（验收格式/数据是否对）与补发（桥接错过了那天的自动发送）。
// 与 preview-group-report.mjs 的分工：那个只打印、绝不发送；这个真的发。
//
//   node scripts/send-group-report.mjs --date 2026-10-02          # 真的发
//   node scripts/send-group-report.mjs --date 2026-10-02 --dry-run  # 只打印将要发送的内容
//
// 安全边界（与桥接内定时发送一致）：
//   · 目标群必须命中 config.json 的 allow.groups（RULES「发送强制白名单」），否则拒绝；
//   · 发送前过一遍敏感信息正则脱敏；
//   · 走 OneBot HTTP API，不依赖桥接进程，也不写任何 state/。
//
// 为什么不用 @snowluma/sdk 的 WebSocket 客户端（scripts/send-test-group.mjs 的写法）：
//   SnowLuma 给 WS 与 HTTP 配的 accessToken 是**两个不同的值**，config.json 里存的是 HTTP 那个，
//   拿它去连 WS 会 401。HTTP 这条路已用 get_login_info 实测可用，所以这里直接用 HTTP。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SENSITIVE_RE } from '../src/sensitive.js';
import {
  DEFAULT_REPORT_AT,
  collectDailyStats,
  decideReportAction,
  formatDailyReport,
  localDateKey,
  lookupMemberNamesFromDb,
  normalizeReportGroupIds,
  parseDateKey,
  pickMessagesDb,
  resolveMessagesDbCandidates,
  shiftDateKey
} from '../src/group-stats.js';
import { collectMuteStats, formatMuteKingSection } from '../src/mute-stats.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = { group: '', date: '', top: null, db: '', dryRun: false, noCompare: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--dry-run' || a === '-n') out.dryRun = true;
    else if (a === '--no-compare') out.noCompare = true;
    else if (a === '--group') out.group = argv[++i] ?? '';
    else if (a === '--date') out.date = argv[++i] ?? '';
    else if (a === '--top') out.top = Number(argv[++i]);
    else if (a === '--db') out.db = argv[++i] ?? '';
    else throw new Error(`未知参数：${a}（用 --help 看用法）`);
  }
  return out;
}

const HELP = `群活跃日报 · 手动发送（会真的发到群里）

用法：node scripts/send-group-report.mjs [选项]

  --date <日期>   要发哪一天的日报（YYYY-MM-DD），默认"刚结束的那一天"
  --group <群号>  目标群，默认取 config.json 的 groupStats.groupIds[0] / groupId
  --top <人数>    活跃榜人数上限，默认 groupStats.leaderboardSize
  --db <路径>     指定 SnowLuma messages.db，默认自动发现
  --dry-run, -n   只打印将要发送的内容，不真的发
  --no-compare    不显示与前一日的环比
  -h, --help      显示本帮助
`;

/** 敏感信息脱敏（与桥接 appendActivity / 定时发送同一套正则）。 */
function redact(text) {
  const flags = SENSITIVE_RE.flags.includes('g') ? SENSITIVE_RE.flags : SENSITIVE_RE.flags + 'g';
  return String(text ?? '').replace(new RegExp(SENSITIVE_RE.source, flags), '***');
}

/** 防止网关把文本里的 [CQ: 当 CQ 码解析（与 bridge.js 的 escapeCqText 一致）。 */
const escapeCqText = (text) => String(text ?? '').replace(/\[CQ:/gi, '[CQ：');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); return; }

  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
  const gs = cfg.groupStats ?? {};

  const groupId = Number(args.group || normalizeReportGroupIds({ groupId: gs.groupId, groupIds: gs.groupIds })[0] || 0);
  if (!Number.isSafeInteger(groupId) || groupId <= 0) {
    throw new Error('没有可用的目标群：请用 --group 指定，或在 config.json 里配 groupStats.groupIds');
  }

  // 与桥接定时发送同一条硬边界：目标群必须命中白名单。
  const allowGroups = (cfg.allow?.groups ?? []).map(String);
  if (!allowGroups.includes(String(groupId))) {
    throw new Error(`群 ${groupId} 不在 config.json 的 allow.groups（${allowGroups.join(', ') || '空'}）内，拒绝发送`);
  }

  let dateKey = String(args.date || '').trim();
  if (dateKey) parseDateKey(dateKey);
  else {
    const decision = decideReportAction({
      reportAt: String(gs.reportAt || DEFAULT_REPORT_AT),
      coverDay: gs.coverDay || 'auto',
      schedule: {},
      catchUpHours: 24 * 365
    });
    dateKey = decision.coveredDateKey ?? shiftDateKey(localDateKey(), -1);
  }

  const explicit = String(args.db || gs.dbPath || '').trim();
  const candidates = resolveMessagesDbCandidates({ explicit, homeDir: cfg.snowluma?.homeDir });
  if (candidates.length === 0) throw new Error('没找到 SnowLuma 消息库（检查 snowluma.homeDir 或用 --db 指定）');
  const dbPath = candidates.length === 1 ? candidates[0] : await pickMessagesDb({ candidates });

  const excludeSelf = gs.excludeSelf !== false;
  const stats = await collectDailyStats({ dbPath, groupId, dateKey, excludeSelf });
  let prevTotal = null;
  if (!args.noCompare) {
    try {
      prevTotal = (await collectDailyStats({ dbPath, groupId, dateKey: shiftDateKey(dateKey, -1), excludeSelf })).total;
    } catch { /* 前一天取不到就不显示环比 */ }
  }

  // 「禁言王」小节：必须与线上调度器、以及 preview-group-report.mjs 保持一致。
  // 【2026-10-03 修】这里以前漏了 —— 预览有、自动发有、手动发没有，
  // 结果同一个功能发出去的内容取决于你用哪个脚本，排查起来极其误导。
  let muteKingLines = [];
  if (gs.muteKingEnabled !== false) {
    const mk = collectMuteStats({
      logPath: path.join(ROOT, 'state', 'group-admin.log'),
      dateKey,
      groupId
    });
    if (mk.total > 0) {
      // 名字优先级与线上一致：当天发言名单 → 历史消息补查 → 兜底文案（**绝不显示 QQ 号**）。
      // 手动发送没有 OneBot 可用，所以少最后一层"群成员表"。
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

  const text = redact(formatDailyReport({
    stats,
    prevTotal,
    leaderboardSize: Number.isFinite(args.top) && args.top > 0 ? args.top : Number(gs.leaderboardSize) || 10,
    maxChars: Number(gs.maxChars) || 900,
    muteKingLines
  }));

  console.log(`群:     ${groupId}${stats.groupName ? `（${stats.groupName}）` : ''}`);
  console.log(`日期:   ${dateKey}`);
  console.log(`消息库: ${dbPath}`);
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
