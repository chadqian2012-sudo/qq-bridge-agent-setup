// 「禁言王」榜的离线回归。
//
// 重点不在"能不能算出来"，而在**口径不能被算歪**：
//   · 只算成功的（FAIL 那次人没被禁言）
//   · 只算 mute（unmute 是解禁）
//   · 只看本群
//   · UTC 时间戳要按**本地日**切（否则 00:00–08:00 的禁言会跑到前一天）
// 这些都会直接变成一个发到群里的数字，算错比不显示更糟。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { collectMuteStats, formatMuteKingSection, parseMuteAuditLine, safeDisplayName, UNKNOWN_MEMBER_LABEL } from '../src/mute-stats.js';

const GID = 9000000012;
const KEY = `group:${GID}`;
const OWNER = '900000013';
const DEPLOYER = '9000000148';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mute-stats-test-'));
process.on('exit', () => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {} });

/** 造一行"已执行"审计日志，字段顺序与 formatExecutedAudit 一致。 */
function okLine({ atIso, by, target, action = 'mute', duration = '1 小时', key = KEY }) {
  return `${atIso} OK   ${key} by=${by} target=${target} action=${action} duration=${duration} detail=done`;
}

/** 把 ISO 时刻算成"本地日 dateKey 的某个 UTC ISO"—— 用本地时间构造再 toISOString，天然带时区换算。 */
function isoAtLocal(dateKey, hour, minute = 0) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(y, m - 1, d, hour, minute, 0).toISOString();
}

function writeLog(lines) {
  const p = path.join(tmpRoot, `log-${Math.random().toString(36).slice(2, 8)}.txt`);
  fs.writeFileSync(p, lines.join('\n') + '\n', 'utf8');
  return p;
}

// ── 行解析 ──────────────────────────────────────────────────────────────────

test('parseMuteAuditLine 解析出关键字段（duration 含空格也不受影响）', () => {
  const rec = parseMuteAuditLine(okLine({ atIso: isoAtLocal('2026-10-03', 12), by: OWNER, target: '9000000018', duration: '12 小时(clamped)' }));
  assert.equal(rec.ok, true);
  assert.equal(rec.by, OWNER);
  assert.equal(rec.target, '9000000018');
  assert.equal(rec.action, 'mute');
  assert.equal(rec.key, KEY);
});

test('parseMuteAuditLine 认识 FAIL / unmute，并忽略 DENY 与 REPORT 行', () => {
  const fail = parseMuteAuditLine(`${isoAtLocal('2026-10-03', 12)} FAIL ${KEY} by=${OWNER} target=1 action=mute duration=0（解除） detail=OneBot 拒绝`);
  assert.equal(fail.ok, false);

  // 被拒（还没到执行阶段）与违规上报都不是禁言，必须解析为 null
  assert.equal(parseMuteAuditLine(`2026-10-03T12:49:17.709Z DENY ${KEY} sender=${DEPLOYER} role=member reason=x text=/mute`), null);
  assert.equal(parseMuteAuditLine(`2026-10-03T12:49:17.709Z REPORT ${KEY} sender=1 role=member action=report pattern=x 命中`), null);
  assert.equal(parseMuteAuditLine('随便一行'), null);
  assert.equal(parseMuteAuditLine(''), null);
});

// ── 聚合口径 ────────────────────────────────────────────────────────────────

test('只统计成功的 mute，且在正确的群与正确的本地日', () => {
  const day = '2026-10-03';
  const log = writeLog([
    okLine({ atIso: isoAtLocal(day, 10), by: OWNER, target: '1001' }),
    okLine({ atIso: isoAtLocal(day, 11), by: OWNER, target: '1001' }),
    okLine({ atIso: isoAtLocal(day, 12), by: DEPLOYER, target: '1002' }),
    // ① 失败：人没被真的禁言
    `${isoAtLocal(day, 13)} FAIL ${KEY} by=${OWNER} target=1002 action=mute duration=1 小时 detail=OneBot 拒绝`,
    // ② 解禁：不算被禁言
    okLine({ atIso: isoAtLocal(day, 14), by: OWNER, target: '1003', action: 'unmute' }),
    // ③ 别的群
    okLine({ atIso: isoAtLocal(day, 15), by: OWNER, target: '1004', key: 'group:900000015' }),
    // ④ 别的日子
    okLine({ atIso: isoAtLocal('2026-10-02', 20), by: OWNER, target: '1005' }),
  ]);

  const s = collectMuteStats({ logPath: log, dateKey: day, groupId: GID });
  assert.equal(s.total, 3, '只应计 2×1001 + 1×1002');
  assert.deepEqual(s.muted, [{ id: '1001', count: 2 }, { id: '1002', count: 1 }]);
  assert.deepEqual(s.mutedBy, [{ id: OWNER, count: 2 }, { id: DEPLOYER, count: 1 }]);
});

test('本地日切分：本地 00:30 的禁言必须算在当天，而不是前一天', () => {
  // 这是最容易错的一处：日志时间戳是 UTC，UTC+8 的 00:30 在 UTC 里还是前一天 16:30。
  const day = '2026-10-03';
  const log = writeLog([
    okLine({ atIso: isoAtLocal(day, 0, 30), by: OWNER, target: '2001' }),
    okLine({ atIso: isoAtLocal(day, 23, 30), by: OWNER, target: '2002' }),
    okLine({ atIso: isoAtLocal('2026-10-02', 23, 59), by: OWNER, target: '2003' }),
    okLine({ atIso: isoAtLocal('2026-10-04', 0, 0), by: OWNER, target: '2004' }),
  ]);
  const s = collectMuteStats({ logPath: log, dateKey: day, groupId: GID });
  assert.equal(s.total, 2);
  assert.deepEqual(s.muted.map((x) => x.id).sort(), ['2001', '2002']);
});

test('同一个人被禁言多次会计多次；排序从高到低，同分按 id 稳定', () => {
  const day = '2026-10-03';
  const log = writeLog([
    okLine({ atIso: isoAtLocal(day, 9), by: DEPLOYER, target: '3002' }),
    okLine({ atIso: isoAtLocal(day, 10), by: DEPLOYER, target: '3001' }),
    okLine({ atIso: isoAtLocal(day, 11), by: DEPLOYER, target: '3001' }),
    okLine({ atIso: isoAtLocal(day, 12), by: DEPLOYER, target: '3001' }),
    okLine({ atIso: isoAtLocal(day, 13), by: DEPLOYER, target: '3003' }),
  ]);
  const s = collectMuteStats({ logPath: log, dateKey: day, groupId: GID });
  assert.deepEqual(s.muted, [{ id: '3001', count: 3 }, { id: '3002', count: 1 }, { id: '3003', count: 1 }]);
  assert.deepEqual(s.mutedBy, [{ id: DEPLOYER, count: 5 }]);
});

test('日志不存在时返回空结果而不是抛错（从未禁言过是正常状态）', () => {
  const s = collectMuteStats({ logPath: path.join(tmpRoot, '不存在.log'), dateKey: '2026-10-03', groupId: GID });
  assert.deepEqual(s, { muted: [], mutedBy: [], total: 0, lines: 0 });
});

// ── 渲染 ────────────────────────────────────────────────────────────────────

test('两个榜都为空时不渲染小节（不往日报里塞空标题）', () => {
  assert.deepEqual(formatMuteKingSection({ muted: [], mutedBy: [] }), []);
});

test('渲染两个榜，人数受 size 限制', () => {
  const muted = Array.from({ length: 8 }, (_, i) => ({ id: `m${i}`, count: 9 - i }));
  const mutedBy = [{ id: OWNER, count: 4 }];
  // 显式给一个能出名字的实现：本模块的默认实现会在解析不出名字时兜底成「某位群友」，
  // 而这一条要测的是"人数上限"，不是名字。
  const resolveName = (id) => `名字${id}`;
  const lines = formatMuteKingSection({ muted, mutedBy, resolveName, size: 3 });
  const text = lines.join('\n');
  assert.match(text, /👑 禁言王/);
  assert.match(text, /被禁言最多：/);
  assert.match(text, /禁言他人最多：/);
  assert.match(text, / 3\. 名字m2 {2}7 次/);
  assert.doesNotMatch(text, /名字m3/, 'size=3 时第 4 名不该出现');
});

test('只有一个榜时不渲染另一个（不写"暂无"占位）', () => {
  const lines = formatMuteKingSection({ muted: [{ id: 'A', count: 1 }], mutedBy: [], size: 5 });
  const text = lines.join('\n');
  assert.match(text, /被禁言最多/);
  assert.doesNotMatch(text, /禁言他人最多/);
});

test('名字解析：查不到名字时显示兜底文案，**绝不显示 QQ 号**', () => {
  const resolveName = (id) => (id === 'A' ? '一个非常非常非常长的群名片名字' : '');
  const lines = formatMuteKingSection({
    muted: [{ id: 'A', count: 2 }, { id: '123456789', count: 1 }],
    mutedBy: [],
    resolveName,
    size: 5
  });
  const text = lines.join('\n');
  assert.match(text, /…/, '超长名字应被截断');
  assert.match(text, /某位群友/, '查不到的应显示兜底文案');
  assert.ok(!text.includes('123456789'), '绝不该把 QQ 号贴到群里');
});

test('渲染结果不以空行开头（分隔空行由日报层负责）', () => {
  // 2026-10-03 实测踩过：小节自己带前导空行，被日报的 filter(Boolean) 吃掉，
  // 结果「👑 禁言王」直接贴在上一行榜单后面，看起来像没换行。
  const lines = formatMuteKingSection({ muted: [{ id: '1', count: 1 }], mutedBy: [], size: 5 });
  assert.notEqual(lines[0], '', '第一个元素不能是空串');
  assert.equal(lines[0], '👑 禁言王');
});

// ── 硬边界：**绝不显示 QQ 号** ──────────────────────────────────────────────
// 日报是发到群里的。把群友的 QQ 号公开贴出来比"某位群友"糟糕得多 ——
// QQ 号是半私密标识，而且不是当事人选择公开的信息。

test('调用方偷懒直接返回 id 时，仍然不会显示 QQ 号', () => {
  const lines = formatMuteKingSection({
    muted: [{ id: '123456789', count: 3 }, { id: '987654321', count: 2 }],
    mutedBy: [{ id: '555555555', count: 1 }],
    resolveName: (id) => String(id),   // 最典型的偷懒实现
    size: 5
  });
  const text = lines.join('\n');
  for (const qq of ['123456789', '987654321', '555555555']) {
    assert.ok(!text.includes(qq), `绝不该出现 QQ 号 ${qq}`);
  }
  assert.match(text, /某位群友/);
});

test('safeDisplayName：空串 / 返回 undefined / 抛异常 一律兜底', () => {
  assert.equal(safeDisplayName('123456789', () => ''), UNKNOWN_MEMBER_LABEL);
  assert.equal(safeDisplayName('123456789', () => undefined), UNKNOWN_MEMBER_LABEL);
  assert.equal(safeDisplayName('123456789', () => null), UNKNOWN_MEMBER_LABEL);
  assert.equal(safeDisplayName('123456789', () => '   '), UNKNOWN_MEMBER_LABEL);
  assert.equal(safeDisplayName('123456789', () => { throw new Error('boom'); }), UNKNOWN_MEMBER_LABEL);
});

test('safeDisplayName：名字本身就是纯数字也会兜底（QQ 号泄露的另一种形态）', () => {
  assert.equal(safeDisplayName('1', () => '123456789'), UNKNOWN_MEMBER_LABEL);
  assert.equal(safeDisplayName('1', () => '12345'), UNKNOWN_MEMBER_LABEL);
  // 4 位以下不算 QQ 号形态，正常群名片可以叫「1234」
  assert.equal(safeDisplayName('1', () => '1234'), '1234');
});

test('safeDisplayName：正常群名片原样返回（含中文、英文、表情）', () => {
  assert.equal(safeDisplayName('1', () => '小心地超人'), '小心地超人');
  assert.equal(safeDisplayName('1', () => 'AbyssalCrab'), 'AbyssalCrab');
  assert.equal(safeDisplayName('1', () => ' 子Zz.（家里蹲版） '), '子Zz.（家里蹲版）');
});

test('调色板：resolveName 缺失（默认实现）也不崩、也不显示数字', () => {
  const lines = formatMuteKingSection({ muted: [{ id: '123456789', count: 1 }], mutedBy: [], size: 5 });
  const text = lines.join('\n');
  assert.ok(!text.includes('123456789'));
  assert.match(text, /某位群友/);
});
