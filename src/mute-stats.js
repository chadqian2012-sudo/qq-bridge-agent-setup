/**
 * 「禁言王」榜：从群管理审计日志里统计**当日**禁言情况 —— 纯逻辑层，零 IO（除读取日志文件）。
 *
 * ## 口径必须说清楚（这份榜单会发到群里，数字被误读比没有更糟）
 *
 * 1. **只统计"通过这台机器人执行"的禁言。** 群主或管理员直接在 QQ 客户端里手动禁言的，
 *    这里**看不到** —— 那些操作不经过我们，写不进日志。所以榜单的准确含义是
 *    「本群今日经由机器人禁言的情况」，不是"本群今日所有禁言"。
 * 2. **只算成功（`OK`）且 `action=mute` 的行。** `FAIL` 表示那次 OneBot 调用失败了，
 *    人并没有真的被禁言；`action=unmute` 是解禁，当然不算。
 * 3. **去重按"次"不按"人"**：同一个人被禁言两次就计两次。
 * 4. 日志是 **UTC 时间戳**，而日报按**本地日**切分，所以这里做时区换算
 *    （`localDateKey` 走本地时区）。否则 00:00–08:00 的禁言会被算到前一天。
 *
 * ## 日志行格式（由 src/group-admin.js 的 formatExecutedAudit 产出）
 *
 * ```
 * 2026-10-03T12:50:00.000Z OK   group:9000000012 by=900000013 target=9000000018 action=mute duration=1 分钟 detail=done
 * ```
 * 注意 `duration=` 的值里可能含空格（"1 小时"），所以**不能按空白切分**，
 * 只能整体正则匹配；这里只取需要的字段，duration 不参与判定
 * （mute / unmute 已经由 action 区分）。
 */

import fs from 'node:fs';

import { localDateKey, truncateName } from './group-stats.js';

/**
 * 解析一行群管理审计日志；不是"已执行的禁言/解禁"就返回 null。
 *
 * 刻意不匹配 `DENY`（被拒）与 `REPORT`（违规上报）行 —— 它们格式不同，
 * 且都不代表真的有人被禁言。
 */
export function parseMuteAuditLine(line) {
  const m = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+(OK|FAIL)\s+(group:\d+|private:\d+)\s+by=(\d+)\s+target=(\d+)\s+action=(mute|unmute)\b/
    .exec(String(line ?? '').trim());
  if (!m) return null;
  return {
    atIso: m[1],
    ok: m[2] === 'OK',
    key: m[3],
    by: m[4],
    target: m[5],
    action: m[6]
  };
}

/**
 * 统计某群某一天的禁言情况。
 *
 * @param {object} o
 * @param {string} o.logPath   审计日志路径（不存在时返回空结果，不抛错）
 * @param {string} o.dateKey   本地日期 YYYY-MM-DD
 * @param {number|string} o.groupId
 * @returns {{muted:Array<{id:string,count:number}>, mutedBy:Array<{id:string,count:number}>,
 *            total:number, lines:number}}
 */
export function collectMuteStats({ logPath, dateKey, groupId }) {
  const key = `group:${String(groupId)}`;
  const empty = { muted: [], mutedBy: [], total: 0, lines: 0 };
  let text = '';
  try {
    text = fs.readFileSync(logPath, 'utf8');
  } catch {
    return empty; // 日志还没生成（从未有禁言）—— 不是错误
  }

  const mutedTally = new Map();
  const byTally = new Map();
  let total = 0;
  let lines = 0;

  for (const raw of text.split('\n')) {
    const rec = parseMuteAuditLine(raw);
    if (!rec) continue;
    lines += 1;
    if (!rec.ok) continue;                       // 失败的那次没有真的禁言
    if (rec.action !== 'mute') continue;         // 解禁不算
    if (rec.key !== key) continue;               // 只看这个群
    // UTC → 本地日：日志写的是 toISOString()，日报按本地日切
    if (localDateKey(Date.parse(rec.atIso)) !== dateKey) continue;

    total += 1;
    mutedTally.set(rec.target, (mutedTally.get(rec.target) ?? 0) + 1);
    byTally.set(rec.by, (byTally.get(rec.by) ?? 0) + 1);
  }

  const sortDesc = (map) => [...map.entries()]
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => b.count - a.count || (a.id < b.id ? -1 : 1));

  return { muted: sortDesc(mutedTally), mutedBy: sortDesc(byTally), total, lines };
}

/**
 * 查不到显示名时的兜底文案。
 *
 * **绝不回落到 QQ 号。** 把群友的 QQ 号公开贴在日报里，比"某位群友"糟糕得多 ——
 * QQ 号是半私密标识，而且这不是当事人自己选择公开的信息。
 */
export const UNKNOWN_MEMBER_LABEL = '某位群友';

/**
 * 安全的显示名：保证**永远不会输出一串纯数字**。
 *
 * 这是本模块的硬边界，不是调用方的礼貌约定 —— 就算调用方把 QQ 号当名字传进来
 * （比如"查不到昵称就 return id"这种偷懒实现），这里也会拦下来。
 * 名字本身是数字的群名片极少见，真遇到也只会显示成兜底文案，代价可以接受。
 */
export function safeDisplayName(id, resolveName) {
  let name = '';
  try {
    name = String(resolveName(id) ?? '').trim();
  } catch {
    name = '';
  }
  if (!name) return UNKNOWN_MEMBER_LABEL;
  if (name === String(id)) return UNKNOWN_MEMBER_LABEL;   // 兜底就是 id 本身
  if (/^\d{5,}$/.test(name)) return UNKNOWN_MEMBER_LABEL; // 名字本身就是 QQ 号
  return name;
}

/**
 * 渲染「禁言王」小节。
 *
 * @param {object} o
 * @param {Array} o.muted      受害榜 [{ id, count }]
 * @param {Array} o.mutedBy    执行榜 [{ id, count }]
 * @param {Function} o.resolveName  (id) => 群名片/昵称；查不到请返回空串（不要返回 id）
 * @param {number} o.size       每榜最多列几个人
 * @returns {string[]} 直接拼进日报的行；两个榜都为空时返回 []
 */
export function formatMuteKingSection({ muted = [], mutedBy = [], resolveName = () => '', size = 5 }) {
  if (!muted.length && !mutedBy.length) return [];
  const n = Math.max(1, Number(size) || 5);
  // 注意：**不带前导空行**。小节前面的分隔空行由日报渲染层负责加
  // （日报那边会 filter(Boolean)，自己带空行反而会被吃掉，2026-10-03 踩过）。
  const lines = ['👑 禁言王'];

  const rank = (list) => list.slice(0, n)
    .map((e, i) => `${String(i + 1).padStart(2, ' ')}. ${truncateName(safeDisplayName(e.id, resolveName))}  ${e.count} 次`)
    .join('\n');

  if (muted.length) {
    lines.push(`被禁言最多：`);
    lines.push(rank(muted));
  }
  if (mutedBy.length) {
    lines.push(`禁言他人最多：`);
    lines.push(rank(mutedBy));
  }
  return lines;
}
