// 群活跃日报（src/group-stats.js）的离线回归。
//
// 全部用 fixture SQLite + 纯函数，**不读生产 SnowLuma 库、不碰 state/、不发任何 QQ 消息**。
// 覆盖三类最容易出错的地方：
//   1. 时区/日期边界（这个功能里唯一会让"今天"整体偏一天的东西）；
//   2. 调度决策的所有分支（重复发送是发到真实群里的，必须靠测试挡住）；
//   3. 统计口径（机器人自己的发言要排除，owner 不能排除）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  ACTIVITY_STAR_THRESHOLDS,
  activityStars,
  collectDailyStatsFromDb,
  collectRangeStatsFromDb,
  dateLabel,
  decideReportAction,
  formatDailyReport,
  formatWindowReport,
  localDateKey,
  localDayRangeSec,
  lookupMemberNamesFromDb,
  normalizeReportGroupIds,
  parseDateKey,
  parseReportAt,
  peakHour,
  pickMessagesDb,
  resolveMessagesDbCandidates,
  shiftDateKey,
  truncateName
} from '../src/group-stats.js';

const GID = 9000000012;
const SELF = 9000000011;   // 机器人自己
const OWNER = 9000000148;  // 人类管理员：**必须计入**统计

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'group-stats-test-'));
process.on('exit', () => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {} });

/** 造一条 OneBot 群消息事件（字段与 SnowLuma 实际入库的形状一致）。 */
function eventData({ ts, userId, nickname = '', card = '', groupName = '测试群', groupId = GID, selfId = SELF }) {
  return JSON.stringify({
    time: ts,
    self_id: selfId,
    post_type: 'message',
    message_type: 'group',
    group_id: groupId,
    group_name: groupName,
    user_id: userId,
    raw_message: '[CQ:image,file=x.jpg]',
    sender: { user_id: userId, nickname, card, role: 'member' }
  });
}

/** 建一个带 messages 表的 fixture 库，返回路径。rows = [{ts,userId,nickname,card,groupName,isGroup,sessionId}] */
function makeFixtureDb(name, rows) {
  const dbPath = path.join(tmpRoot, name, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  return { dbPath, rows };
}

let sqlite = null;
try { sqlite = await import('node:sqlite'); } catch { /* Node 22 未开 --experimental-sqlite */ }
const dbTest = sqlite ? test : test.skip;
if (!sqlite) console.log('⚠️ 当前 Node 不支持 node:sqlite，跳过所有依赖消息库的用例');

/** 真正把 fixture 写进 SQLite，返回 {dbPath, db}。 */
function buildDb({ dbPath, rows }) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new sqlite.DatabaseSync(dbPath);
  db.exec(`CREATE TABLE messages (
    message_hash INTEGER, is_group INTEGER, session_id INTEGER, sequence INTEGER,
    sequence_authoritative INTEGER, event_name TEXT, client_sequence INTEGER,
    private_direction INTEGER, random INTEGER, timestamp INTEGER, data TEXT,
    classification_version INTEGER)`);
  const ins = db.prepare('INSERT INTO messages (is_group, session_id, timestamp, data) VALUES (?,?,?,?)');
  for (const r of rows) {
    ins.run(r.isGroup === false ? 0 : 1, r.sessionId ?? GID, r.ts, eventData(r));
  }
  return db;
}

/** 本地某天某时:某分 → Unix 秒。 */
function atLocal(dateKey, hour, minute = 0, second = 0) {
  const [y, m, d] = parseDateKey(dateKey);
  return Math.floor(new Date(y, m - 1, d, hour, minute, second).getTime() / 1000);
}

// ── 时区 / 日期 ────────────────────────────────────────────────────────────

test('localDateKey 用本地时区，不受 UTC 影响', () => {
  // 本地 2026-10-03 00:30：若用 toISOString() 会得到 UTC 的 10-02，正是要避免的偏一天。
  const ms = new Date(2026, 9, 3, 0, 30).getTime();
  assert.equal(localDateKey(ms), '2026-10-03');
  const late = new Date(2026, 9, 3, 23, 59, 59).getTime();
  assert.equal(localDateKey(late), '2026-10-03');
});

test('shiftDateKey 跨月、跨年、闰年都正确', () => {
  assert.equal(shiftDateKey('2026-10-03', -1), '2026-10-02');
  assert.equal(shiftDateKey('2026-11-01', -1), '2026-10-31');
  assert.equal(shiftDateKey('2027-01-01', -1), '2026-12-31');
  assert.equal(shiftDateKey('2028-03-01', -1), '2028-02-29'); // 闰年
  assert.equal(shiftDateKey('2026-02-28', 1), '2026-03-01');
});

test('parseDateKey 拒绝格式错和"不存在的日期"', () => {
  assert.deepEqual(parseDateKey('2026-10-03'), [2026, 10, 3]);
  assert.throws(() => parseDateKey('2026-10-3'));
  assert.throws(() => parseDateKey('2026/10/03'));
  assert.throws(() => parseDateKey(''));
  // 关键：Date 会把 2 月 30 日静默滚到 3 月 2 日，必须在入口挡住。
  assert.throws(() => parseDateKey('2026-02-30'));
  assert.throws(() => parseDateKey('2026-13-01'));
});

test('localDayRangeSec 是本地 00:00 → 次日 00:00，且恰好 24 小时', () => {
  const { startSec, endSec } = localDayRangeSec('2026-10-03');
  assert.equal(startSec, atLocal('2026-10-03', 0, 0, 0));
  assert.equal(endSec, atLocal('2026-10-04', 0, 0, 0));
  assert.equal(endSec - startSec, 86400);
});

test('dateLabel 输出中文月日', () => {
  assert.equal(dateLabel('2026-10-03'), '10月3日');
  assert.equal(dateLabel('2026-01-09'), '1月9日');
});

test('parseReportAt 只接受合法 HH:MM', () => {
  assert.deepEqual(parseReportAt('00:00'), { hour: 0, minute: 0 });
  assert.deepEqual(parseReportAt('23:59'), { hour: 23, minute: 59 });
  assert.deepEqual(parseReportAt('7:05'), { hour: 7, minute: 5 });
  for (const bad of ['', '24:00', '12:60', '1200', 'noon', null, undefined]) {
    assert.equal(parseReportAt(bad), null, `应拒绝 ${JSON.stringify(bad)}`);
  }
});

test('日报目标群：groupIds 数组优先，没写才用旧单值 groupId', () => {
  // 多群（本次需求：清波寨 + 练功房各发一份）
  assert.deepEqual(normalizeReportGroupIds({ groupId: 9000000012, groupIds: [9000000012, 9000000016] }), [9000000012, 9000000016]);
  // 只写旧的单值，行为与改动前一致
  assert.deepEqual(normalizeReportGroupIds({ groupId: 9000000012 }), [9000000012]);
  assert.deepEqual(normalizeReportGroupIds({ groupId: '9000000012' }), [9000000012]);
  // 去重 + 保持顺序
  assert.deepEqual(normalizeReportGroupIds({ groupIds: [2, 1, 2, 1] }), [2, 1]);
  // 写了空数组 = 明确"一个都不发"，不能被 groupId 悄悄顶回来
  assert.deepEqual(normalizeReportGroupIds({ groupId: 9000000012, groupIds: [] }), []);
  // 非法值一律丢弃（宁可不发，也不朝乱码群号发消息）
  assert.deepEqual(normalizeReportGroupIds({ groupIds: ['abc', 0, -1, 1.5, null, undefined, ' 9000000012 '] }), [9000000012]);
  assert.deepEqual(normalizeReportGroupIds({}), []);
  assert.deepEqual(normalizeReportGroupIds(), []);
});

// ── 调度决策 ───────────────────────────────────────────────────────────────

test('报告点还没到、且上一次触发早已出窗口 → 不会补发旧报告', () => {
  // 10/3 23:00 看 reportAt=23:30：最近一次触发是 10/2 23:30，已迟到 23.5 小时。
  const nowMs = new Date(2026, 9, 3, 23, 0).getTime();
  const d = decideReportAction({ nowMs, reportAt: '23:30', schedule: {}, catchUpHours: 6 });
  assert.equal(d.action, 'give-up');
  assert.equal(d.coveredDateKey, '2026-10-02');
});

test('reportAt 在傍晚时，桥接次日凌晨才起来也能补发前一天那份', () => {
  // 这是"只看今天那个点"的写法会漏掉的场景：10/4 00:30，10/4 23:00 还没到，
  // 但 10/3 23:00 那次该发的是 10/3 的日报。
  const nowMs = new Date(2026, 9, 4, 0, 30).getTime();
  const d = decideReportAction({ nowMs, reportAt: '23:00', coverDay: 'auto', schedule: {}, catchUpHours: 6 });
  assert.equal(d.action, 'send');
  assert.equal(d.coveredDateKey, '2026-10-03');
});

test('00:00 到点 → 发的是"刚结束的那一天"（昨天）', () => {
  // 10/4 00:00:30 触发 → 覆盖 10/3
  const nowMs = new Date(2026, 9, 4, 0, 0, 30).getTime();
  const d = decideReportAction({ nowMs, reportAt: '00:00', coverDay: 'auto', schedule: {} });
  assert.equal(d.action, 'send');
  assert.equal(d.coveredDateKey, '2026-10-03');
});

test('傍晚的 reportAt → 覆盖当天（coverDay=auto）', () => {
  const nowMs = new Date(2026, 9, 3, 23, 1).getTime();
  const d = decideReportAction({ nowMs, reportAt: '23:00', coverDay: 'auto', schedule: {} });
  assert.equal(d.action, 'send');
  assert.equal(d.coveredDateKey, '2026-10-03');
});

test('coverDay 显式覆盖 auto 推断', () => {
  const nowMs = new Date(2026, 9, 4, 0, 0, 30).getTime();
  assert.equal(decideReportAction({ nowMs, reportAt: '00:00', coverDay: 'today', schedule: {} }).coveredDateKey, '2026-10-04');
  assert.equal(decideReportAction({ nowMs, reportAt: '23:00', coverDay: 'yesterday', schedule: {} }).coveredDateKey, '2026-10-02');
});

test('已处理过这一天 → idle（防重复发送）', () => {
  const nowMs = new Date(2026, 9, 4, 0, 5).getTime();
  const d = decideReportAction({ nowMs, reportAt: '00:00', schedule: { lastSentFor: '2026-10-03' } });
  assert.equal(d.action, 'idle');
  assert.equal(d.reason, 'already-handled');
});

test('换了一天之后继续发新的一天（不会被上一次的记账卡住）', () => {
  const nowMs = new Date(2026, 9, 5, 0, 5).getTime();
  const d = decideReportAction({ nowMs, reportAt: '00:00', schedule: { lastSentFor: '2026-10-03' } });
  assert.equal(d.action, 'send');
  assert.equal(d.coveredDateKey, '2026-10-04');
});

test('超出补发窗口 → give-up（桥接停机太久就别补了）', () => {
  const nowMs = new Date(2026, 9, 4, 9, 0).getTime(); // 迟到 9 小时
  const d = decideReportAction({ nowMs, reportAt: '00:00', schedule: {}, catchUpHours: 6 });
  assert.equal(d.action, 'give-up');
  assert.equal(d.coveredDateKey, '2026-10-03');
  assert.match(d.reason, /补发窗口/);
});

test('窗口内迟到 → 仍然补发', () => {
  const nowMs = new Date(2026, 9, 4, 3, 0).getTime(); // 迟到 3 小时
  const d = decideReportAction({ nowMs, reportAt: '00:00', schedule: {}, catchUpHours: 6 });
  assert.equal(d.action, 'send');
  assert.equal(d.coveredDateKey, '2026-10-03');
});

test('失败后进入退避等待，而不是连续重试', () => {
  const schedule = { coveredDateKey: '2026-10-03', attempts: 1, lastAttemptAt: new Date(2026, 9, 4, 0, 1).getTime() };
  const soon = decideReportAction({ nowMs: new Date(2026, 9, 4, 0, 2).getTime(), reportAt: '00:00', schedule, retryBackoffMs: 15 * 60 * 1000 });
  assert.equal(soon.action, 'wait');
  assert.match(soon.reason, /等待重试/);
  const later = decideReportAction({ nowMs: new Date(2026, 9, 4, 0, 20).getTime(), reportAt: '00:00', schedule, retryBackoffMs: 15 * 60 * 1000 });
  assert.equal(later.action, 'send');
  assert.equal(later.attempts, 1);
});

test('重试到上限 → give-up', () => {
  const schedule = { coveredDateKey: '2026-10-03', attempts: 3, lastAttemptAt: 0 };
  const d = decideReportAction({ nowMs: new Date(2026, 9, 4, 0, 5).getTime(), reportAt: '00:00', schedule, maxAttempts: 3 });
  assert.equal(d.action, 'give-up');
  assert.match(d.reason, /放弃这一天/);
});

test('reportAt 非法 → invalid（不猜、不静默）', () => {
  assert.equal(decideReportAction({ nowMs: Date.now(), reportAt: '25:00', schedule: {} }).action, 'invalid');
});

// ── 统计口径 ───────────────────────────────────────────────────────────────

dbTest('统计条数、排序、群名片取最后一次发言', () => {
  const day = '2026-10-03';
  const rows = [
    // 甲 3 条，中途改了群名片
    { ts: atLocal(day, 10, 0), userId: 111, nickname: '甲', card: '甲甲' },
    { ts: atLocal(day, 11, 0), userId: 111, nickname: '甲', card: '甲甲' },
    { ts: atLocal(day, 12, 0), userId: 111, nickname: '甲', card: '甲甲改名了' },
    // 乙 2 条
    { ts: atLocal(day, 13, 0), userId: 222, nickname: '乙', card: '' },
    { ts: atLocal(day, 14, 0), userId: 222, nickname: '乙', card: '' },
    // 丙 1 条
    { ts: atLocal(day, 15, 0), userId: 333, nickname: '丙', card: '' },
    // 机器人自己 2 条 —— 必须被排除
    { ts: atLocal(day, 16, 0), userId: SELF, nickname: '小鲸鱼', card: '' },
    { ts: atLocal(day, 17, 0), userId: SELF, nickname: '小鲸鱼', card: '' },
    // owner 1 条 —— 必须计入（owner 是群里的人，不是机器人）
    { ts: atLocal(day, 18, 0), userId: OWNER, nickname: '管理员', card: '' },
  ];
  const db = buildDb(makeFixtureDb('basic', rows));
  try {
    const s = collectDailyStatsFromDb({ db, groupId: GID, dateKey: day });
    assert.equal(s.total, 7, '总条数不含机器人自己的 2 条');
    assert.equal(s.selfCount, 2, '单独记下机器人自己的条数');
    assert.equal(s.activeMembers, 4, '甲/乙/丙/owner = 4 人');
    assert.equal(s.groupName, '测试群');
    assert.deepEqual(s.members.map((m) => [m.userId, m.count]), [
      ['111', 3], ['222', 2], [String(OWNER), 1], ['333', 1]
    ]);
    // 同分时按最后一次发言时间倒序：owner 在 18:00，丙在 15:00
    assert.equal(s.members[2].userId, String(OWNER));
    assert.equal(s.members.find((m) => m.userId === '111').name, '甲甲改名了');
    assert.equal(s.members.find((m) => m.userId === '222').name, '乙', '没群名片时退回昵称');
  } finally { db.close(); }
});

dbTest('excludeSelf=false 时机器人自己的发言也计入', () => {
  const day = '2026-10-03';
  const rows = [
    { ts: atLocal(day, 10, 0), userId: 111, nickname: '甲' },
    { ts: atLocal(day, 11, 0), userId: SELF, nickname: '小鲸鱼' },
  ];
  const db = buildDb(makeFixtureDb('noself', rows));
  try {
    const s = collectDailyStatsFromDb({ db, groupId: GID, dateKey: day, excludeSelf: false });
    assert.equal(s.total, 2);
    assert.equal(s.selfCount, 0);
    assert.equal(s.activeMembers, 2);
  } finally { db.close(); }
});

dbTest('按本地日切开：前一天 23:59:59 与次日 00:00:00 都不落进来', () => {
  const day = '2026-10-03';
  const rows = [
    { ts: atLocal(day, 0, 0, 0) - 1, userId: 111, nickname: '前一天最后一秒' },
    { ts: atLocal(day, 0, 0, 0), userId: 111, nickname: '当天第一秒' },
    { ts: atLocal(day, 23, 59, 59), userId: 111, nickname: '当天最后一秒' },
    { ts: atLocal(day, 23, 59, 59) + 1, userId: 111, nickname: '次日第一秒' },
  ];
  const db = buildDb(makeFixtureDb('boundary', rows));
  try {
    const s = collectDailyStatsFromDb({ db, groupId: GID, dateKey: day });
    assert.equal(s.total, 2, '只有当天首尾两条在区间内');
  } finally { db.close(); }
});

dbTest('只统计指定群，别的群不串进来', () => {
  const day = '2026-10-03';
  const rows = [
    { ts: atLocal(day, 10, 0), userId: 111, nickname: '甲' },
    { ts: atLocal(day, 11, 0), userId: 222, nickname: '别群的人', sessionId: 999999, groupName: '别的群' },
  ];
  const db = buildDb(makeFixtureDb('crossgroup', rows));
  try {
    const s = collectDailyStatsFromDb({ db, groupId: GID, dateKey: day });
    assert.equal(s.total, 1);
    assert.equal(s.groupName, '测试群');
  } finally { db.close(); }
});

dbTest('最活跃时段按本地小时分桶', () => {
  const day = '2026-10-03';
  const rows = [
    { ts: atLocal(day, 21, 5), userId: 111, nickname: '甲' },
    { ts: atLocal(day, 21, 30), userId: 222, nickname: '乙' },
    { ts: atLocal(day, 21, 55), userId: 333, nickname: '丙' },
    { ts: atLocal(day, 9, 0), userId: 111, nickname: '甲' },
  ];
  const db = buildDb(makeFixtureDb('hourly', rows));
  try {
    const s = collectDailyStatsFromDb({ db, groupId: GID, dateKey: day });
    assert.equal(s.hourly[21], 3);
    assert.equal(s.hourly[9], 1);
    assert.deepEqual(peakHour(s.hourly), { hour: 21, count: 3 });
  } finally { db.close(); }
});

dbTest('当天没人发言时，群名仍能从历史消息兜底取到', () => {
  const rows = [{ ts: atLocal('2026-10-01', 10, 0), userId: 111, nickname: '甲' }];
  const db = buildDb(makeFixtureDb('emptyday', rows));
  try {
    const s = collectDailyStatsFromDb({ db, groupId: GID, dateKey: '2026-10-03' });
    assert.equal(s.total, 0);
    assert.equal(s.activeMembers, 0);
    assert.equal(s.groupName, '测试群', '群名与当天有没有人说话无关');
  } finally { db.close(); }
});

dbTest('坏 JSON 行不会让整份统计失败', () => {
  const day = '2026-10-03';
  const db = buildDb(makeFixtureDb('badrow', [
    { ts: atLocal(day, 10, 0), userId: 111, nickname: '甲' },
  ]));
  try {
    db.prepare('INSERT INTO messages (is_group, session_id, timestamp, data) VALUES (1,?,?,?)')
      .run(GID, atLocal(day, 11, 0), '{ 这不是 JSON');
    const s = collectDailyStatsFromDb({ db, groupId: GID, dateKey: day });
    assert.equal(s.total, 1);
  } finally { db.close(); }
});

dbTest('groupId 非法直接抛错（不静默返回 0）', () => {
  const db = buildDb(makeFixtureDb('badgid', []));
  try {
    for (const bad of [0, -1, 'abc', null]) {
      assert.throws(() => collectDailyStatsFromDb({ db, groupId: bad, dateKey: '2026-10-03' }));
    }
  } finally { db.close(); }
});

// ── 渲染 ───────────────────────────────────────────────────────────────────

test('truncateName 按码点截断，不劈开 emoji', () => {
  assert.equal(truncateName('短名字'), '短名字');
  assert.equal(truncateName(''), '未知');
  assert.equal(truncateName('  '), '未知');
  const long = truncateName('一二三四五六七八九十十一十二十三');
  assert.equal(Array.from(long).length, 12);
  assert.ok(long.endsWith('…'));
  // 全是 emoji 也要保住整颗
  const emoji = truncateName('🦑🦑🦑🦑🦑🦑🦑🦑🦑🦑🦑🦑🦑🦑');
  assert.equal(Array.from(emoji).length, 12);
  assert.ok(!emoji.includes('\uFFFD'));
});

test('activityStars 按阈值分档，0 条是空星', () => {
  assert.equal(activityStars(0), '☆☆☆☆☆');
  assert.equal(activityStars(1), '★☆☆☆☆');
  assert.equal(activityStars(ACTIVITY_STAR_THRESHOLDS[1] - 1), '★☆☆☆☆');
  assert.equal(activityStars(ACTIVITY_STAR_THRESHOLDS[1]), '★★☆☆☆');
  assert.equal(activityStars(10 ** 6), '★★★★★');
});

test('peakHour 空数据返回 null', () => {
  assert.equal(peakHour(new Array(24).fill(0)), null);
  assert.equal(peakHour(null), null);
});

function sampleStats(overrides = {}) {
  const members = [
    { userId: '1', name: '阿甲', count: 60, lastAt: 0 },
    { userId: '2', name: '阿乙', count: 40, lastAt: 0 },
    { userId: '3', name: '阿丙', count: 20, lastAt: 0 },
    { userId: '4', name: '阿丁', count: 10, lastAt: 0 },
    { userId: '5', name: '阿戊', count: 5, lastAt: 0 },
  ];
  return {
    groupId: GID, groupName: '测试群', dateKey: '2026-10-03',
    total: 135, selfCount: 3, activeMembers: members.length, members,
    hourly: new Array(24).fill(0).map((_, i) => (i === 21 ? 50 : 0)),
    ...overrides
  };
}

test('日报包含总数、参与人数、TOP3 奖牌与完整活跃榜', () => {
  const text = formatDailyReport({ stats: sampleStats(), prevTotal: 100, leaderboardSize: 10 });
  assert.match(text, /测试群 · 10月3日 群活跃日报/);
  assert.match(text, /群友发言 135 条（\+35% 较前日）/);
  assert.match(text, /参与群友 5 人/);
  assert.match(text, /最活跃 21:00 时段 50 条/);
  assert.match(text, /🥇 阿甲 {2}60 条（44\.4%）/);
  assert.match(text, /🥈 阿乙/);
  assert.match(text, /🥉 阿丙/);
  assert.match(text, /📋 完整活跃榜/);
  assert.match(text, / 4\. 阿丁 {2}10 条/);
  assert.match(text, / 5\. 阿戊/);
  assert.match(text, /活跃度 ★★☆☆☆/); // 135 条落在 [50,150) 档
});

test('前日无人发言时不显示百分比，改说明原因', () => {
  const text = formatDailyReport({ stats: sampleStats(), prevTotal: 0 });
  assert.match(text, /（前日无人发言）/);
  assert.doesNotMatch(text, /较前日/);
});

test('空数据日报：说清是哪一天没人说话', () => {
  const text = formatDailyReport({ stats: sampleStats({ total: 0, members: [], activeMembers: 0 }), prevTotal: 12 });
  assert.match(text, /💤 10月3日 群里没有人发言/);
  assert.match(text, /（前一日 12 条）/);
  assert.doesNotMatch(text, /TOP3/);
});

test('活跃榜人数不超过 leaderboardSize', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ userId: String(i), name: `人${i}`, count: 30 - i, lastAt: 0 }));
  const text = formatDailyReport({ stats: sampleStats({ members: many, total: 465, activeMembers: 30 }), leaderboardSize: 6 });
  assert.match(text, / 6\. 人5/);
  assert.doesNotMatch(text, / 7\. 人6/);
});

test('超长时优先保住总数与 TOP3，整体不超上限', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ userId: String(i), name: `名字很长很长的群友${i}`, count: 60 - i, lastAt: 0 }));
  const stats = sampleStats({ members: many, total: 1830, activeMembers: 60 });
  const text = formatDailyReport({ stats, leaderboardSize: 60, maxChars: 300 });
  assert.ok(text.length <= 300, `长度 ${text.length} 应 <= 300`);
  assert.match(text, /群友发言 1830 条/);
  assert.match(text, /🥇/);
  assert.match(text, /🥉/);
});

// ── 消息库定位 ─────────────────────────────────────────────────────────────

test('显式 dbPath 指向不存在的文件 → 返回空候选（不猜别的库）', () => {
  const missing = path.join(tmpRoot, 'nope', 'messages.db');
  assert.deepEqual(resolveMessagesDbCandidates({ explicit: missing, homeDir: tmpRoot }), []);
});

test('显式 dbPath 存在时优先于 homeDir 自动发现', () => {
  const p = path.join(tmpRoot, 'explicit', 'messages.db');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '');
  assert.deepEqual(resolveMessagesDbCandidates({ explicit: p, homeDir: tmpRoot }), [p]);
});

test('homeDir 缺失/无 data 目录 → 空候选而不是抛错', () => {
  assert.deepEqual(resolveMessagesDbCandidates({ homeDir: '' }), []);
  assert.deepEqual(resolveMessagesDbCandidates({ homeDir: path.join(tmpRoot, 'nope') }), []);
});

dbTest('自动发现 data/*/messages.db 并按新→旧排序', async () => {
  const home = path.join(tmpRoot, 'home');
  for (const [uin, rows] of [
    ['old', [{ ts: atLocal('2026-09-01', 10, 0), userId: 1, nickname: 'a' }]],
    ['new', [{ ts: atLocal('2026-10-03', 10, 0), userId: 1, nickname: 'a' }]],
  ]) {
    const db = buildDb({ dbPath: path.join(home, 'data', uin, 'messages.db'), rows });
    db.close();
  }
  const found = resolveMessagesDbCandidates({ homeDir: home });
  assert.equal(found.length, 2);
  // 文件 mtime 相同（同一批写入）时顺序不保证，这里只要求两个都被发现
  assert.ok(found.some((p) => p.includes(`${path.sep}old${path.sep}`)));
  assert.ok(found.some((p) => p.includes(`${path.sep}new${path.sep}`)));

  // pickMessagesDb 才是真正的裁决：认「最后一次收到群消息」最晚的那个。
  const picked = await pickMessagesDb({ candidates: found });
  assert.ok(picked.includes(`${path.sep}new${path.sep}`), `应选到数据更新的库，实得 ${picked}`);
});

dbTest('pickMessagesDb 跳过结构不符的库', async () => {
  const home = path.join(tmpRoot, 'home2');
  const badPath = path.join(home, 'bad', 'messages.db');
  fs.mkdirSync(path.dirname(badPath), { recursive: true });
  const bad = new sqlite.DatabaseSync(badPath);
  bad.exec('CREATE TABLE 别的表 (x INTEGER)');
  bad.close();
  const goodDb = buildDb({ dbPath: path.join(home, 'good', 'messages.db'), rows: [{ ts: atLocal('2026-10-03', 10, 0), userId: 1, nickname: 'a' }] });
  goodDb.close();
  const picked = await pickMessagesDb({ candidates: [badPath, path.join(home, 'good', 'messages.db')] });
  assert.ok(picked.includes(`${path.sep}good${path.sep}`), `应跳过无 messages 表的库，实得 ${picked}`);
});

// ── 时间窗（近 N 分钟） ────────────────────────────────────────────────────
// 「近 10 分钟活跃」是即时查询，走的是与日报**同一份聚合口径**；这组用例同时守住
// 两件事：区间切得对，以及日报没有在重构后偷偷换了一套算法。

dbTest('collectRangeStatsFromDb 按显式区间取数，半开区间 [start, end)', () => {
  const s0 = atLocal('2026-10-03', 12, 0, 0);
  const rows = [
    { ts: s0 - 1, userId: 111, nickname: '区间前' },
    { ts: s0, userId: 111, nickname: '区间首' },
    { ts: s0 + 10, userId: 222, nickname: '区间中' },
    { ts: s0 + 20, userId: 222, nickname: '区间尾' },
    { ts: s0 + 20, userId: 111, nickname: '区间末' },
  ];
  const db = buildDb(makeFixtureDb('range', rows));
  try {
    const s = collectRangeStatsFromDb({ db, groupId: GID, startSec: s0, endSec: s0 + 20 });
    // 半开区间 [s0, s0+20)：s0 与 s0+10 在内（2 条），s0-1 与两条 s0+20 都在外。
    assert.equal(s.total, 2, '应含 [start, end) 内的 2 条：区间前 1 条、端点 end 那 2 条都不算');
    assert.equal(s.startSec, s0);
    assert.equal(s.endSec, s0 + 20);
    assert.equal(s.activeMembers, 2);
  } finally { db.close(); }
});

dbTest('按天统计与等价的显式区间结果完全一致（共用聚合口径）', () => {
  const day = '2026-10-03';
  const rows = [
    { ts: atLocal(day, 9, 0), userId: 111, nickname: '甲', card: '甲甲' },
    { ts: atLocal(day, 9, 30), userId: 111, nickname: '甲', card: '甲改名了' },
    { ts: atLocal(day, 20, 0), userId: SELF, nickname: '小鲸鱼' },
    { ts: atLocal(day, 21, 0), userId: OWNER, nickname: '管理员' },
  ];
  const db = buildDb(makeFixtureDb('samecore', rows));
  try {
    const daily = collectDailyStatsFromDb({ db, groupId: GID, dateKey: day });
    const { startSec, endSec } = localDayRangeSec(day);
    const range = collectRangeStatsFromDb({ db, groupId: GID, startSec, endSec });
    assert.equal(daily.total, range.total);
    assert.equal(daily.activeMembers, range.activeMembers);
    assert.equal(daily.selfCount, range.selfCount);
    assert.deepEqual(daily.members, range.members);
    assert.equal(daily.dateKey, day, '只有按天版本带 dateKey');
    assert.equal(range.dateKey, undefined);
  } finally { db.close(); }
});

dbTest('collectRangeStatsFromDb 拒绝非法区间与非法群号', () => {
  const db = buildDb(makeFixtureDb('badrange', []));
  try {
    assert.throws(() => collectRangeStatsFromDb({ db, groupId: GID, startSec: 100, endSec: 100 }), '空区间应抛错');
    assert.throws(() => collectRangeStatsFromDb({ db, groupId: GID, startSec: 200, endSec: 100 }), '倒置区间应抛错');
    assert.throws(() => collectRangeStatsFromDb({ db, groupId: GID, startSec: NaN, endSec: 100 }), 'NaN 应抛错');
    assert.throws(() => collectRangeStatsFromDb({ db, groupId: 0, startSec: 100, endSec: 200 }), '群号非法应抛错');
  } finally { db.close(); }
});

function windowStats(overrides = {}) {
  const startSec = atLocal('2026-10-03', 19, 14, 0);
  return {
    groupId: GID,
    groupName: '测试群',
    startSec,
    // +601 而不是 +600：collectWindowStats 的 endSec 是「floor(now/1000)+1」，
    // 也就是比真实截止晚 1 秒（为了含住当前这一秒）。这里按同一约定构造，
    // 渲染时再退掉那 1 秒 → 显示 19:14–19:24。
    endSec: startSec + 601,
    windowMinutes: 10,
    total: 40,
    selfCount: 1,
    activeMembers: 3,
    members: [
      { userId: '1', name: 'OjbK', count: 22, lastAt: 0 },
      { userId: '2', name: '小心地超人', count: 16, lastAt: 0 },
      { userId: '3', name: '柒墨', count: 2, lastAt: 0 },
    ],
    hourly: new Array(24).fill(0),
    ...overrides
  };
}

test('近 N 分钟报告：区间、条数、人数、条/分与榜单', () => {
  const text = formatWindowReport({ stats: windowStats() });
  assert.match(text, /测试群 · 近 10 分钟活跃/);
  assert.match(text, /🕘 19:14–19:24/, '区间末端要回退 1 秒显示，不能写成 19:25');
  assert.match(text, /发言 40 条 · 3 人参与 · 4\.0 条\/分/);
  assert.match(text, /🥇 OjbK {2}22 条/);
  assert.match(text, /🥈 小心地超人/);
  assert.match(text, /🥉 柒墨/);
});

test('近 N 分钟报告：没人说话时给一句人话，不硬凑榜单', () => {
  const text = formatWindowReport({ stats: windowStats({ total: 0, activeMembers: 0, members: [] }) });
  assert.match(text, /💤 这 10 分钟群里没人说话/);
  assert.doesNotMatch(text, /发言榜/);
});

test('近 N 分钟报告：榜单人数受 topN 限制', () => {
  const members = Array.from({ length: 12 }, (_, i) => ({ userId: String(i), name: `人${i}`, count: 20 - i, lastAt: 0 }));
  const text = formatWindowReport({ stats: windowStats({ members, total: 200, activeMembers: 12 }), topN: 5 });
  assert.match(text, / 5\. 人4/);
  assert.doesNotMatch(text, / 6\. 人5/);
});

// ── 「禁言王」小节接入日报 ───────────────────────────────────────────────────
// 日报渲染层只接收**已渲染好的行**，不关心禁言的业务含义（数据与口径在 src/mute-stats.js）。

test('日报会插入「禁言王」小节，位置在活跃度之前', () => {
  const muteKingLines = ['', '👑 禁言王', '被禁言最多：', ' 1. 阿甲  3 次', '禁言他人最多：', ' 1. 群主  2 次'];
  const text = formatDailyReport({ stats: sampleStats(), prevTotal: 100, muteKingLines });
  assert.match(text, /👑 禁言王/);
  assert.match(text, /被禁言最多：/);
  assert.match(text, /禁言他人最多：/);
  // 位置：禁言王 必须排在 活跃度 之前
  assert.ok(text.indexOf('👑 禁言王') < text.indexOf('🔥 活跃度'), '禁言王应排在活跃度之前');
  // 且不能挤掉原有内容
  assert.match(text, /群友发言 135 条/);
  assert.match(text, /🥇 阿甲/);
});

test('没传 / 传空数组时不渲染「禁言王」小节', () => {
  const a = formatDailyReport({ stats: sampleStats(), prevTotal: 100 });
  const b = formatDailyReport({ stats: sampleStats(), prevTotal: 100, muteKingLines: [] });
  for (const t of [a, b]) {
    assert.doesNotMatch(t, /禁言王/);
    assert.match(t, /🔥 活跃度/);
  }
});

test('当天群里没人说话时，「禁言王」小节照样出现（禁言与发言量无关）', () => {
  const text = formatDailyReport({
    stats: sampleStats({ total: 0, members: [], activeMembers: 0 }),
    prevTotal: 0,
    muteKingLines: ['', '👑 禁言王', '被禁言最多：', ' 1. 阿甲  1 次']
  });
  assert.match(text, /💤 10月3日 群里没有人发言/);
  assert.match(text, /👑 禁言王/);
});

test('「禁言王」小节里的空行会被过滤掉，不会产生连续空行', () => {
  const text = formatDailyReport({
    stats: sampleStats(),
    prevTotal: 0,
    muteKingLines: ['', '', null, '👑 禁言王', '被禁言最多：', '', ' 1. 阿甲  1 次']
  });
  assert.doesNotMatch(text, /\n\n\n/, '不该出现连续三个换行');
  assert.match(text, /👑 禁言王/);
});

test('「禁言王」标题前必须有一个空行（曾被 filter(Boolean) 吃掉分隔行）', () => {
  const text = formatDailyReport({
    stats: sampleStats(),
    prevTotal: 0,
    muteKingLines: ['👑 禁言王', '被禁言最多：', ' 1. 阿甲  1 次']
  });
  assert.match(text, /\n\n👑 禁言王/, '标题前应有空行，否则会贴在上一行榜单后面');
});

test('没人发言 + 有禁言记录时，空数据分支也加分隔空行', () => {
  const text = formatDailyReport({
    stats: sampleStats({ total: 0, members: [], activeMembers: 0 }),
    prevTotal: 0,
    muteKingLines: ['👑 禁言王', '被禁言最多：', ' 1. 阿甲  1 次']
  });
  assert.match(text, /\n\n👑 禁言王/);
});

// ── 用历史消息补查群名片 ────────────────────────────────────────────────────
// 场景：被禁言的人当天没发言，取不到昵称 —— 以前会回落到显示 QQ 号（不可接受），
// 现在改成回查历史消息。这一组盯的就是"能不能查到"以及"群名片优先"。

dbTest('lookupMemberNamesFromDb：查历史消息补昵称，且群名片优先于昵称', async () => {
  // 注意 buildDb 返回的是 **db 对象**（不是 {dbPath}），路径要从 makeFixtureDb 拿。
  const rows = [
    // 张三：当天没发言（时间戳在很久以前），有群名片
    { ts: 1_700_000_000, userId: '9001', nickname: '老昵称', card: '张三的群名片' },
    // 李四：没有群名片，只有昵称
    { ts: 1_700_000_100, userId: '9002', nickname: '李四昵称', card: '' },
    // 王五：发过两次，应取**最近一条**的群名片
    { ts: 1_700_000_200, userId: '9003', nickname: 'w', card: '旧名片' },
    { ts: 1_700_000_300, userId: '9003', nickname: 'w', card: '新名片' }
  ];
  const { dbPath } = makeFixtureDb('lookup', rows);
  const db = buildDb({ dbPath, rows });
  db.close();

  const names = await lookupMemberNamesFromDb({ dbPath, groupId: GID, userIds: ['9001', '9002', '9003', '9999'] });
  assert.equal(names.get('9001'), '张三的群名片', '群名片优先于昵称');
  assert.equal(names.get('9002'), '李四昵称', '没有群名片时用昵称');
  assert.equal(names.get('9003'), '新名片', '同一人多次发言应取最近一条');
  assert.equal(names.has('9999'), false, '从没发过言的人不该出现在结果里（绝不回落成 QQ 号）');
});

dbTest('lookupMemberNamesFromDb：空 ids / 非法 id 不报错', async () => {
  const { dbPath } = makeFixtureDb('lookup2', []);
  buildDb({ dbPath, rows: [] }).close();
  assert.equal((await lookupMemberNamesFromDb({ dbPath, groupId: GID, userIds: [] })).size, 0);
  assert.equal((await lookupMemberNamesFromDb({ dbPath, groupId: GID, userIds: ['abc', '', null] })).size, 0);
});

dbTest('lookupMemberNamesFromDb：库里没有 messages 表时返回空 Map 而不是抛错', async () => {
  const dbPath = path.join(tmpRoot, 'lookup3', 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const raw = new sqlite.DatabaseSync(dbPath);
  raw.exec('CREATE TABLE 别的表 (x INTEGER)');
  raw.close();
  const names = await lookupMemberNamesFromDb({ dbPath, groupId: GID, userIds: ['9001'] });
  assert.equal(names.size, 0);
});
