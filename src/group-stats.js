/**
 * 群活跃日报（group-stats）
 *
 * 干什么：统计「某个 QQ 群在某一天」的发言情况，生成一段可直接发到群里的纯文本日报
 *         （发言总条数 / 发言榜 TOP3 / 完整活跃榜 / 最活跃时段）。
 *
 * 数据从哪来：**SnowLuma 自己的本地消息库** `homeDir/data/<账号>/messages.db` 的 `messages` 表。
 *   表结构（OneBot 原始事件，一行一条消息）：
 *     is_group=1       群消息
 *     session_id       群号
 *     timestamp        Unix **秒**
 *     data             OneBot 群消息事件的 JSON（含 group_name / user_id / sender.nickname / sender.card）
 *
 * 为什么不用桥接侧实时计数：
 *   1. 桥接的 `qstate/qq-activity.log` 是被 `createCappedLogger` 限行的滚动日志（默认 500 行），
 *      且行首只有 `[HH:MM:SS]`、**没有日期**，跨天后无法区分“今天”与“昨天”。
 *   2. 桥接在 `closed-agent` 模式（本机当前模式）下，群消息在 `handleIncoming` 入口就被
 *      `modeAllowed` 整体忽略，实时计数会得到 0。
 *   3. 消息库由 SnowLuma 写入，**与桥接是否在跑无关**：桥接停机期间的消息同样在库里。
 *   所以消息库是唯一既完整又跨模式可靠的数据源。
 *
 * 依赖：`node:sqlite`。它在 Node 22 需要 `--experimental-sqlite`，在 Node 24 才默认可用，
 *   而本仓库 engines 是 `>=22.13.0`。因此这里**一律用动态 import**，绝不在模块顶层静态导入——
 *   否则 Node 22 上桥接会在启动阶段直接崩掉（一个可选功能不该有这种杀伤力）。
 */

import fs from 'node:fs';
import path from 'node:path';

// ── 常量 ────────────────────────────────────────────────────────────────────

/** 日报默认发送时刻（本地时间 24 小时制 HH:MM）。 */
export const DEFAULT_REPORT_AT = '00:00';

/**
 * 活跃度星级阈值（按当日群友发言条数，取第一个 `total < max` 的档位）。
 * 数值来自本机三个白名单群的实际量级：冷清小群约 20~40 条/天，热闹群 250~800 条/天。
 */
export const ACTIVITY_STAR_THRESHOLDS = Object.freeze([0, 50, 150, 400, 800]);

/** 群名片/昵称在榜单里的最大显示宽度（按码点算，避免把 emoji 从中间截断）。 */
const MAX_NAME_CHARS = 12;

// ── 时间工具（全部走本地时区）─────────────────────────────────────────────

/**
 * 毫秒时间戳 → 本地 `YYYY-MM-DD`。
 * 刻意不用 `toISOString()`：那是 UTC，UTC+8 的 00:00~08:00 会被算到前一天。
 */
export function localDateKey(atMs = Date.now()) {
  const d = new Date(atMs);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** `YYYY-MM-DD` 平移若干天（走本地日历，跨月/跨年/夏令时都由 Date 处理）。 */
export function shiftDateKey(dateKey, deltaDays) {
  const [y, m, d] = parseDateKey(dateKey);
  return localDateKey(new Date(y, m - 1, d + deltaDays).getTime());
}

/** `YYYY-MM-DD` → [年, 月, 日]；非法输入抛错（调用方是配置/CLI 边界，应该显式失败）。 */
export function parseDateKey(dateKey) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey ?? '').trim());
  if (!m) throw new Error(`日期格式必须是 YYYY-MM-DD，收到「${dateKey}」`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // 反查校准：拒绝 2026-02-30 这类"格式对但不存在"的日期（否则会被 Date 静默滚动到 3 月）。
  const probe = new Date(y, mo - 1, d);
  if (probe.getFullYear() !== y || probe.getMonth() !== mo - 1 || probe.getDate() !== d) {
    throw new Error(`日期不存在：${dateKey}`);
  }
  return [y, mo, d];
}

/**
 * 本地某一天的 Unix 秒区间 `[startSec, endSec)`。
 * 用本地 Date 构造而不是 `dateKey + 'T00:00:00Z'`：后者在 UTC+8 会整体偏 8 小时。
 */
export function localDayRangeSec(dateKey) {
  const [y, m, d] = parseDateKey(dateKey);
  const start = new Date(y, m - 1, d, 0, 0, 0, 0);
  const end = new Date(y, m - 1, d + 1, 0, 0, 0, 0);
  return { startSec: Math.floor(start.getTime() / 1000), endSec: Math.floor(end.getTime() / 1000) };
}

/** `HH:MM` → `{ hour, minute }`；非法返回 null（由调用方决定告警还是忽略）。 */
export function parseReportAt(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/**
 * 日报目标群规范化。
 *
 * 兼容两种配置写法：
 *   · 旧的单值：`groupStats.groupId: 9000000012`
 *   · 新的多值：`groupStats.groupIds: [9000000012, 9000000016]`（每个群各自记账、各自发一份）
 *
 * 语义：**写了 `groupIds` 数组就以它为准**（哪怕是空数组 —— 那是"我确实一个也不想发"，
 * 不能被 `groupId` 悄悄顶回来）；只有完全没写 `groupIds` 时才回落到 `groupId`。
 * 非法值直接丢弃（fail-closed：宁可少发，也不要朝一个乱码群号发消息）。
 *
 * @param {{groupId?: number|string, groupIds?: Array<number|string>}} o
 * @returns {number[]} 去重后的合法群号，保持输入顺序
 */
export function normalizeReportGroupIds({ groupId, groupIds } = {}) {
  const raw = Array.isArray(groupIds) ? groupIds : (groupId === undefined || groupId === null ? [] : [groupId]);
  const out = [];
  for (const v of raw) {
    const n = Number(typeof v === 'string' ? v.trim() : v);
    if (!Number.isSafeInteger(n) || n <= 0) continue;
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/** `YYYY-MM-DD` → 「10月2日」。 */
export function dateLabel(dateKey) {
  const [, m, d] = parseDateKey(dateKey);
  return `${m}月${d}日`;
}

// ── 调度决策（纯函数，便于离线回归）───────────────────────────────────────

/**
 * 决定「现在这一刻要不要发日报」，不发就说明原因。所有 IO 都在调用方，这里只算。
 *
 * 覆盖日（coveredDateKey）语义：日报覆盖**到点那一刻刚刚结束的那一天**。
 *   reportAt = 00:00 → 此刻"今天"才开始，所以覆盖昨天（10/4 00:00 发 10/3 的日报）；
 *   reportAt = 23:00 → 当天还没结束但已足够完整，覆盖当天。
 * `coverDay: 'auto'` 用「到点小时 < 12 就算昨天」表达这个区分；也可以强制 'today' / 'yesterday'。
 *
 * @returns {{action:'idle'|'wait'|'send'|'give-up'|'invalid', coveredDateKey?:string,
 *            dueMs?:number, attempts?:number, reason:string}}
 */
export function decideReportAction({
  nowMs = Date.now(),
  reportAt = DEFAULT_REPORT_AT,
  coverDay = 'auto',
  schedule = {},
  catchUpHours = 6,
  maxAttempts = 3,
  retryBackoffMs = 15 * 60 * 1000
} = {}) {
  const parsed = parseReportAt(reportAt);
  if (!parsed) return { action: 'invalid', reason: `reportAt 不是合法 HH:MM：「${reportAt}」` };

  // 取「**最近一次已经过去的**触发时刻」，而不是"今天那个点"。
  // 差别在 reportAt 是傍晚（如 23:00）时：10/4 凌晨 00:30 这一刻，今天 23:00 还没到，
  // 但 10/3 23:00 那次早该发了——如果只看"今天那个点"，就会一路等到 10/4 23:00，
  // 10/3 那份直接丢失。回退一天后，补发窗口的判定才落在那次真正该发的触发上。
  const now = new Date(nowMs);
  let due = new Date(now.getFullYear(), now.getMonth(), now.getDate(), parsed.hour, parsed.minute, 0, 0);
  if (nowMs < due.getTime()) {
    due = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, parsed.hour, parsed.minute, 0, 0);
  }
  const dueMs = due.getTime();

  // 防御性分支：上面已保证 dueMs <= nowMs，真走到这里说明系统时钟被往回调过。
  if (nowMs < dueMs) return { action: 'wait', dueMs, reason: 'not-due-yet' };

  const mode = coverDay === 'today' || coverDay === 'yesterday'
    ? coverDay
    : (parsed.hour < 12 ? 'yesterday' : 'today');
  const coveredDateKey = mode === 'today' ? localDateKey(dueMs) : shiftDateKey(localDateKey(dueMs), -1);

  // 已经处理过这一天（发出去了，或明确跳过）→ 什么都不做。
  if (schedule?.lastSentFor === coveredDateKey) {
    return { action: 'idle', coveredDateKey, dueMs, reason: 'already-handled' };
  }

  const lateMs = nowMs - dueMs;
  if (lateMs > Math.max(0, catchUpHours) * 3600 * 1000) {
    return { action: 'give-up', coveredDateKey, dueMs, reason: `超出补发窗口 ${catchUpHours}h（已迟到 ${(lateMs / 3600000).toFixed(1)}h）` };
  }

  // 只有"这一次日期"的失败次数才继承，换了一天就从 0 开始。
  const attempts = schedule?.coveredDateKey === coveredDateKey ? Number(schedule.attempts) || 0 : 0;
  if (attempts >= Math.max(1, maxAttempts)) {
    return { action: 'give-up', coveredDateKey, dueMs, attempts, reason: `连续失败 ${attempts} 次，放弃这一天` };
  }
  // 失败重试要拉开间隔：轮询间隔只有半分钟，真让三次重试连续跑完，
  // SnowLuma/网络短暂抽风就会白白丢掉一整天的日报。
  if (attempts > 0 && schedule?.coveredDateKey === coveredDateKey) {
    const lastAttemptAt = Number(schedule?.lastAttemptAt) || 0;
    const sinceMs = lastAttemptAt ? nowMs - lastAttemptAt : Infinity;
    if (sinceMs < Math.max(0, retryBackoffMs)) {
      return { action: 'wait', coveredDateKey, dueMs, attempts, reason: `上次失败后等待重试（还剩 ${Math.ceil((Math.max(0, retryBackoffMs) - sinceMs) / 60000)} 分钟）` };
    }
  }

  return { action: 'send', coveredDateKey, dueMs, attempts, reason: attempts > 0 ? `第 ${attempts + 1} 次尝试` : '到点' };
}

// ── 消息库定位 ──────────────────────────────────────────────────────────────

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/**
 * 列出候选的 `messages.db` 路径，**最新的排前面**。
 * 显式配置 `explicit` 时只返回它（用户说了算，不再猜）。
 */
export function resolveMessagesDbCandidates({ explicit = '', homeDir = '' } = {}) {
  const out = [];
  const want = String(explicit ?? '').trim();
  if (want) {
    const p = path.resolve(want);
    return isFile(p) ? [p] : [];
  }
  const dataDir = String(homeDir ?? '').trim() ? path.join(String(homeDir).trim(), 'data') : '';
  if (!dataDir || !isDir(dataDir)) return out;
  let entries = [];
  try { entries = fs.readdirSync(dataDir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const p = path.join(dataDir, e.name, 'messages.db');
    if (!isFile(p)) continue;
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(p).mtimeMs; } catch {}
    out.push({ path: p, mtimeMs });
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs).map((x) => x.path);
}

/**
 * 打开消息库：只读优先，失败才退到读写（只跑 SELECT）。
 *
 * 为什么会有第二种：SQLite 的 WAL 库在只读打开时需要能读 `-shm`，某些时刻（`-shm` 缺失/权限不足）
 * 会直接 `SQLITE_CANTOPEN`。退到读写只是让 SQLite 自己建/复用 `-shm`，属于标准行为，
 * 不会改用户数据；用完立刻 close。
 */
export async function openMessagesStore(dbPath) {
  let sqlite;
  try {
    sqlite = await import('node:sqlite');
  } catch (error) {
    throw new Error(`当前 Node 不带 node:sqlite（Node 22 需 --experimental-sqlite，Node 24 默认可用）：${error?.message ?? error}`);
  }
  const { DatabaseSync } = sqlite;
  let firstError = null;
  for (const readOnly of [true, false]) {
    try {
      const db = new DatabaseSync(dbPath, { readOnly });
      db.exec('PRAGMA busy_timeout = 4000;');
      return db;
    } catch (error) {
      if (firstError === null) firstError = error;
    }
  }
  throw new Error(`打开消息库失败：${dbPath}（${firstError?.message ?? firstError}）`);
}

/** 库是否是我们认识的结构（SnowLuma 换版本后表没了就该明确报错，而不是默默发 0 条）。 */
export function messagesTableAvailable(db) {
  try {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'").get();
    return Boolean(row);
  } catch {
    return false;
  }
}

/**
 * 从候选里挑出**当前正在用的**那个库。
 *
 * 判定标准是「最后一次收到群消息的时间最晚」，而不是库体积或文件 mtime：
 *   · 换过 QQ 账号时，旧账号的库可能又大又全，但它已经不更新了——按体积挑会选到死库，
 *     日报会一天天地重复旧账号最后那天的数据。
 *   · `data/` 下同时存在多个账号时，只有当前登录的那个还在写。
 *   · mtime 会被 checkpoint / 只读打开等无关操作碰到，不如直接看数据本身。
 *
 * ⚠️ **刻意不合并多个账号的库**：账号切换前后可能有一段两个号同时在群里、
 * 同一批消息被两边各记一份的重叠期（本机 2026-10-02 22:12 就有 28 条这种重叠），
 * 合并会把它们算成两倍。宁可只认当前账号，也不做出偏高且看不出来的数字。
 */
export async function pickMessagesDb({ candidates }) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  let best = null;
  let bestAt = -1;
  for (const p of candidates) {
    let db = null;
    try {
      db = await openMessagesStore(p);
      if (!messagesTableAvailable(db)) continue;
      const row = db.prepare('SELECT MAX(timestamp) AS t FROM messages WHERE is_group=1').get();
      const t = Number(row?.t) || 0;
      if (t > bestAt) { bestAt = t; best = p; }
    } catch {
      // 打不开/结构不符：跳过这个候选。
    } finally {
      try { db?.close(); } catch {}
    }
  }
  return best ?? candidates[0];
}

// ── 统计 ────────────────────────────────────────────────────────────────────

/**
 * 统计某群某天的发言情况。
 *
 * @param {object} o
 * @param {object} o.db            已打开的 node:sqlite DatabaseSync
 * @param {number|string} o.groupId
 * @param {string} o.dateKey       本地日期 YYYY-MM-DD
 * @param {boolean} o.excludeSelf  是否把机器人自己的发言排除出统计（默认 true）
 * @returns {{groupId:number, groupName:string, dateKey:string, total:number, selfCount:number,
 *            activeMembers:number, members:Array, hourly:number[]}}
 */
/**
 * 把一批消息行聚合成统计结果 —— **「按自然日」与「任意时间窗」共用这一份口径**。
 * 抽出来是为了让 `collectRangeStatsFromDb` 与 `collectDailyStatsFromDb` 不出现两份
 * 各自演化的排序/排除/取名逻辑（改名规则、排除机器人、坏行容错都只在这里写一次）。
 */
function aggregateGroupRows({ rows, gid, excludeSelf, db }) {
  const byUser = new Map();
  const hourly = new Array(24).fill(0);
  let total = 0;
  let selfCount = 0;
  let groupName = '';

  for (const row of rows) {
    let ev;
    try {
      ev = JSON.parse(row.data);
    } catch {
      continue; // 坏行不该让整份统计失败：跳过并继续统计其余的。
    }
    const userId = ev?.user_id === undefined || ev?.user_id === null ? '' : String(ev.user_id);
    const ts = Number(row.timestamp) || Number(ev?.time) || 0;

    if (ev?.group_name) groupName = String(ev.group_name);
    // 机器人自己的发言不算「群友发言」。SnowLuma 会把它记进同一张表（user_id === self_id），
    // 不排掉就会把机器人自己排进活跃榜。注意排除依据是**每行自带的 self_id**，
    // 不是 config 的 ownerQQ：owner 是群里的人类管理员，他的发言理应计入。
    const rowSelfId = ev?.self_id === undefined || ev?.self_id === null ? '' : String(ev.self_id);
    if (excludeSelf && rowSelfId && userId === rowSelfId) { selfCount += 1; continue; }
    if (!userId) continue;

    total += 1;
    const hour = new Date(ts * 1000).getHours();
    if (hour >= 0 && hour < 24) hourly[hour] += 1;

    const name = String(ev?.sender?.card || ev?.sender?.nickname || userId);
    const cur = byUser.get(userId);
    if (cur) {
      cur.count += 1;
      // 后出现的名字覆盖先前的：群名片会改，取最后一次发言时的名字最贴近现状。
      if (name) cur.name = name;
      if (ts > cur.lastAt) cur.lastAt = ts;
    } else {
      byUser.set(userId, { userId, name, count: 1, lastAt: ts });
    }
  }

  const members = [...byUser.values()].sort((a, b) => b.count - a.count || b.lastAt - a.lastAt);

  // 群名兜底：这段时间没人发言时上面扫不到 group_name，显示就会退化成只有群号。
  // 群名与"有没有人说话"无关，单独从该群最近任意一条消息里取。
  if (!groupName && db) {
    try {
      const row = db.prepare('SELECT data FROM messages WHERE is_group=1 AND session_id=? ORDER BY timestamp DESC LIMIT 1').get(gid);
      if (row) {
        const ev = JSON.parse(row.data);
        if (ev?.group_name) groupName = String(ev.group_name);
      }
    } catch { /* 取不到就继续用群号显示 */ }
  }

  return { groupName, total, selfCount, members, hourly };
}

/**
 * 按**显式 Unix 秒区间** `[startSec, endSec)` 统计某群。
 *
 * @param {object} o
 * @param {object} o.db            已打开的 node:sqlite DatabaseSync
 * @param {number|string} o.groupId
 * @param {number} o.startSec
 * @param {number} o.endSec
 * @param {boolean} o.excludeSelf  是否把机器人自己的发言排除出统计（默认 true）
 */
export function collectRangeStatsFromDb({ db, groupId, startSec, endSec, excludeSelf = true }) {
  const gid = Number(groupId);
  if (!Number.isSafeInteger(gid) || gid <= 0) throw new Error(`groupId 非法：${groupId}`);
  const from = Math.floor(Number(startSec));
  const to = Math.ceil(Number(endSec));
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    throw new Error(`时间区间非法：[${startSec}, ${endSec})`);
  }

  const rows = db.prepare(
    `SELECT data, timestamp FROM messages
      WHERE is_group = 1 AND session_id = ? AND timestamp >= ? AND timestamp < ?
      ORDER BY timestamp`
  ).all(gid, from, to);

  const agg = aggregateGroupRows({ rows, gid, excludeSelf, db });
  return {
    groupId: gid,
    startSec: from,
    endSec: to,
    groupName: agg.groupName,
    total: agg.total,
    selfCount: agg.selfCount,
    activeMembers: agg.members.length,
    members: agg.members,
    hourly: agg.hourly
  };
}

/**
 * 按**本地自然日**统计某群某天。
 *
 * @param {object} o
 * @param {object} o.db            已打开的 node:sqlite DatabaseSync
 * @param {number|string} o.groupId
 * @param {string} o.dateKey       本地日期 YYYY-MM-DD
 * @param {boolean} o.excludeSelf  是否把机器人自己的发言排除出统计（默认 true）
 * @returns {{groupId:number, groupName:string, dateKey:string, total:number, selfCount:number,
 *            activeMembers:number, members:Array, hourly:number[], startSec:number, endSec:number}}
 */
export function collectDailyStatsFromDb({ db, groupId, dateKey, excludeSelf = true }) {
  const { startSec, endSec } = localDayRangeSec(dateKey);
  return { ...collectRangeStatsFromDb({ db, groupId, startSec, endSec, excludeSelf }), dateKey };
}

/** 打开候选库并统计；库不可用/无表时抛错（调用方据此决定是否重试）。 */
export async function collectDailyStats({ dbPath, groupId, dateKey, excludeSelf = true }) {
  const db = await openMessagesStore(dbPath);
  try {
    if (!messagesTableAvailable(db)) {
      throw new Error(`消息库里没有 messages 表（SnowLuma 版本不符？）：${dbPath}`);
    }
    return collectDailyStatsFromDb({ db, groupId, dateKey, excludeSelf });
  } finally {
    try { db.close(); } catch {}
  }
}

/**
 * 用**历史消息**补查群名片（**不限当天**）。
 *
 * 为什么需要：某些功能拿到的是 QQ 号（例如群管理审计日志里的禁言对象），
 * 而那个人**当天可能一句话都没说** —— 这时"当天发言名单"里根本没有他，
 * 就取不到昵称。
 *
 * 这里回查这个人在本群**最近一条**消息的 `sender.card` / `sender.nickname`。
 * 名字一律 **群名片优先**（`card`），退而用昵称（`nickname`）。
 *
 * 查不到就**不放进结果**（调用方自己决定怎么显示）—— 但**绝不要因此去显示 QQ 号**，
 * 见 src/mute-stats.js 里的硬保证。
 *
 * @returns {Promise<Map<string,string>>} userId -> 显示名（只含查到的）
 */
export async function lookupMemberNamesFromDb({ dbPath, groupId, userIds = [] }) {
  const out = new Map();
  const ids = [...new Set((userIds ?? []).map(String).filter((s) => /^\d+$/.test(s)))];
  if (!ids.length) return out;

  const db = await openMessagesStore(dbPath);
  try {
    if (!messagesTableAvailable(db)) return out;
    const stmt = db.prepare(
      // user_id 在 JSON 里可能是数字（SnowLuma 当前写入的是数字），也可能是字符串。
      // SQLite 里 `'9001' = 9001` 是 **false**（跨类型比较不相等），所以两边都 CAST 成文本，
      // 否则换个 SnowLuma 版本就会静默查不到人 —— 而查不到的后果是显示"某位群友"。
      `SELECT json_extract(data,'$.sender.card') AS card, json_extract(data,'$.sender.nickname') AS nick
       FROM messages
       WHERE is_group=1 AND session_id=?
         AND CAST(json_extract(data,'$.user_id') AS TEXT)=?
       ORDER BY timestamp DESC LIMIT 1`
    );
    for (const id of ids) {
      try {
        const row = stmt.get(Number(groupId), String(id));
        const name = String(row?.card || row?.nick || '').trim();
        if (name) out.set(id, name);
      } catch {
        // 单个人查不到（老版本 SQLite 无 json_extract、或该 id 从没发过言）不影响其他人。
      }
    }
  } finally {
    try { db.close(); } catch {}
  }
  return out;
}

/**
 * 统计**最近一段时间窗**（默认到"现在"为止）。用于「近 N 分钟活跃」这类即时查询。
 *
 * 与日报共用同一份聚合口径，但时间是显式窗口而不是自然日。
 * `untilMs` 的秒值 +1，是为了把"当前这一秒"里刚落库的消息也算进来 ——
 * 否则 19:25:03 查询时，19:25:03 那条会被排除，看起来像少了一条。
 */
export async function collectWindowStats({ dbPath, groupId, windowMinutes, untilMs = Date.now(), excludeSelf = true }) {
  const mins = Number(windowMinutes);
  if (!Number.isFinite(mins) || mins <= 0) throw new Error(`windowMinutes 非法：${windowMinutes}`);
  const end = Number(untilMs);
  const startSec = Math.floor((end - mins * 60 * 1000) / 1000);
  const endSec = Math.floor(end / 1000) + 1;

  const db = await openMessagesStore(dbPath);
  try {
    if (!messagesTableAvailable(db)) {
      throw new Error(`消息库里没有 messages 表（SnowLuma 版本不符？）：${dbPath}`);
    }
    return { ...collectRangeStatsFromDb({ db, groupId, startSec, endSec, excludeSelf }), windowMinutes: mins, untilMs: end };
  } finally {
    try { db.close(); } catch {}
  }
}

// ── 文本渲染 ────────────────────────────────────────────────────────────────

/** 按码点截断，避免把 emoji / 代理对从中间劈开。 */
export function truncateName(name, max = MAX_NAME_CHARS) {
  const chars = Array.from(String(name ?? '').trim() || '未知');
  return chars.length <= max ? chars.join('') : chars.slice(0, max - 1).join('') + '…';
}

/** 当日发言条数 → 活跃度星级（★×n + ☆×(5-n)）。 */
export function activityStars(total, thresholds = ACTIVITY_STAR_THRESHOLDS) {
  let n = 1;
  for (let i = 1; i < thresholds.length; i += 1) if (Number(total) >= thresholds[i]) n = i + 1;
  if (Number(total) <= 0) n = 0;
  return '★'.repeat(n) + '☆'.repeat(5 - n);
}

/** 最活跃的时段（小时）；返回 null 表示当天没有任何消息。 */
export function peakHour(hourly) {
  if (!Array.isArray(hourly)) return null;
  let best = -1;
  let bestCount = 0;
  for (let h = 0; h < hourly.length; h += 1) {
    if (hourly[h] > bestCount) { bestCount = hourly[h]; best = h; }
  }
  return bestCount > 0 ? { hour: best, count: bestCount } : null;
}

function pct(part, whole) {
  if (!whole) return '0%';
  return `${((part / whole) * 100).toFixed(1)}%`;
}

/**
 * 渲染日报纯文本。
 *
 * @param {object} o
 * @param {object} o.stats           collectDailyStats 的结果
 * @param {number|null} o.prevTotal  前一天的总条数（用于环比），null = 不显示
 * @param {number} o.leaderboardSize 活跃榜列出的人数上限
 * @param {number} o.maxChars        文本上限，超出就从榜单尾部开始删
 */
export function formatDailyReport({ stats, prevTotal = null, leaderboardSize = 10, maxChars = 900, muteKingLines = [] }) {
  const title = stats.groupName ? `${stats.groupName} · ${dateLabel(stats.dateKey)} 群活跃日报`
    : `群 ${stats.groupId} · ${dateLabel(stats.dateKey)} 群活跃日报`;
  const out = [`📊 ${title}`, '━━━━━━━━━━━━━━'];
  // 「禁言王」小节由调用方渲染好后传进来（数据来自群管理审计日志，不在本模块的职责里）。
  // 用数组而不是对象，是为了让这一层完全不关心禁言的业务含义。
  const muteBlock = Array.isArray(muteKingLines) ? muteKingLines.filter(Boolean) : [];

  if (!stats.total) {
    // 不写死「昨天」：coverDay='today'（reportAt 在傍晚之后）时覆盖的就是当天。
    out.push(`💤 ${dateLabel(stats.dateKey)} 群里没有人发言`);
    if (Number(prevTotal) > 0) out.push(`（前一日 ${prevTotal} 条）`);
    if (muteBlock.length) out.push('', ...muteBlock);
    return out.join('\n');
  }

  let trend = '';
  if (prevTotal !== null && prevTotal !== undefined && Number.isFinite(Number(prevTotal))) {
    const prev = Number(prevTotal);
    if (prev > 0) {
      const delta = ((stats.total - prev) / prev) * 100;
      trend = `（${delta >= 0 ? '+' : ''}${delta.toFixed(0)}% 较前日）`;
    } else {
      trend = '（前日无人发言）';
    }
  }
  out.push(`💬 群友发言 ${stats.total} 条${trend}`);
  out.push(`👥 参与群友 ${stats.activeMembers} 人`);

  const peak = peakHour(stats.hourly);
  if (peak) out.push(`🕘 最活跃 ${String(peak.hour).padStart(2, '0')}:00 时段 ${peak.count} 条`);

  const medals = ['🥇', '🥈', '🥉'];
  const top = stats.members.slice(0, 3);
  if (top.length) {
    out.push('', '🏆 发言榜 TOP3');
    top.forEach((m, i) => {
      out.push(`${medals[i]} ${truncateName(m.name)}  ${m.count} 条（${pct(m.count, stats.total)}）`);
    });
  }

  const rest = stats.members.slice(3, Math.max(3, leaderboardSize));
  if (rest.length) {
    out.push('', '📋 完整活跃榜');
    rest.forEach((m, i) => {
      out.push(`${String(i + 4).padStart(2, ' ')}. ${truncateName(m.name)}  ${m.count} 条`);
    });
  }

  // 分隔空行由这一层补：小节自己带的空行会被上面的 filter(Boolean) 吃掉。
  if (muteBlock.length) out.push('', ...muteBlock);

  out.push('', `🔥 活跃度 ${activityStars(stats.total)}`);

  // 超长兜底：从"完整活跃榜"的最后一行开始往前删，保证头部的总数/TOP3/星级一定发得出去。
  const limit = Math.max(120, Number(maxChars) || 900);
  let text = out.join('\n');
  while (text.length > limit) {
    const idx = out.map((l) => /^\s*\d+\.\s/.test(l)).lastIndexOf(true);
    if (idx <= 0) break;
    out.splice(idx, 1);
    text = out.join('\n');
  }
  if (text.length > limit) text = text.slice(0, limit - 1) + '…';
  return text;
}

/** `HH:MM`（本地）。窗口报告用它标出区间，精确到分钟就够，不必带秒。 */
function hhmm(atMsOrSec, isSec = false) {
  const ms = isSec ? Number(atMsOrSec) * 1000 : Number(atMsOrSec);
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * 渲染「近 N 分钟活跃」的即时报告（比日报短，适合随时插一句）。
 *
 * @param {object} o
 * @param {object} o.stats          collectWindowStats 的结果
 * @param {number} o.topN           榜单人数上限（默认 8）
 * @param {number} o.maxChars       文本上限
 */
export function formatWindowReport({ stats, topN = 8, maxChars = 600 }) {
  const mins = Number(stats.windowMinutes) || 0;
  const title = stats.groupName ? `${stats.groupName} · 近 ${mins} 分钟活跃` : `群 ${stats.groupId} · 近 ${mins} 分钟活跃`;
  const out = [`📊 ${title}`, '━━━━━━━━━━━━━━'];

  // 时间区间用 startSec/endSec（都是本地时区）。endSec 比真实截止多 1 秒（为了含住当前这一秒），
  // 显示时往回退 1 秒，免得写成 19:25–19:26 这种看起来多一分钟的区间。
  if (stats.startSec && stats.endSec) {
    out.push(`🕘 ${hhmm(stats.startSec, true)}–${hhmm(stats.endSec - 1, true)}`);
  }

  if (!stats.total) {
    out.push(`💤 这 ${mins} 分钟群里没人说话`);
    return out.join('\n');
  }

  const perMin = (stats.total / mins).toFixed(1);
  out.push(`💬 发言 ${stats.total} 条 · ${stats.activeMembers} 人参与 · ${perMin} 条/分`);

  const medals = ['🥇', '🥈', '🥉'];
  const list = stats.members.slice(0, Math.max(1, topN));
  if (list.length) {
    out.push('', '🏆 发言榜');
    list.forEach((m, i) => {
      const lead = i < 3 ? medals[i] : `${String(i + 1).padStart(2, ' ')}.`;
      out.push(`${lead} ${truncateName(m.name)}  ${m.count} 条`);
    });
  }

  const limit = Math.max(120, Number(maxChars) || 600);
  let text = out.join('\n');
  while (text.length > limit) {
    const idx = out.map((l) => /^\s*\d+\.\s/.test(l)).lastIndexOf(true);
    if (idx <= 0) break;
    out.splice(idx, 1);
    text = out.join('\n');
  }
  if (text.length > limit) text = text.slice(0, limit - 1) + '…';
  return text;
}
