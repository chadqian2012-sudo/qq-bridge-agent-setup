// 群管理命令（禁言/解除）纯逻辑的离线回归。
//
// 这组用例的重点**不是**功能多全，而是**授权边界不能被绕过**：
// 禁言是"让真人闭嘴"的动作，一旦判定写错，被惩罚的是真实群友。
// 所以权限矩阵、目标解析、自我保护都在这里逐条钉死，且完全不联网、不碰真群。
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_DURATION_MS,
  DEFAULT_MAX_DURATION_MS,
  analyzeCommandSegments,
  authorizeMuteCommand,
  checkMuteTargetSafety,
  clampDuration,
  formatDeniedAudit,
  formatExecutedAudit,
  humanDuration,
  looksLikeBadDuration,
  looksLikeMuteCommand,
  parseDuration,
  parseMuteCommand,
  resolveMuteTarget
} from '../src/group-admin.js';

const OWNER_QQ = '900000013';   // 微雨·启明（群里真正的 owner）
const BOT_QQ = '9000000011';
const MEMBER_QQ = '9000000148';

// ── 时长解析 ────────────────────────────────────────────────────────────────

test('parseDuration 支持 s/m/h/d，纯数字按分钟', () => {
  assert.equal(parseDuration('30m'), 30 * 60 * 1000);
  assert.equal(parseDuration('1h'), 3600 * 1000);
  assert.equal(parseDuration('12h'), 12 * 3600 * 1000);
  assert.equal(parseDuration('3d'), 3 * 86400 * 1000);
  assert.equal(parseDuration('90s'), 90 * 1000);
  assert.equal(parseDuration('30'), 30 * 60 * 1000, '纯数字按分钟，群里最不容易写错');
  assert.equal(parseDuration('1.5h'), 90 * 60 * 1000);
  assert.equal(parseDuration(' 2H '), 2 * 3600 * 1000, '大小写与空白都要容错');
});

test('parseDuration 对无法识别的输入返回 null（绝不猜默认值）', () => {
  for (const bad of ['', '  ', 'abc', '2hs', '1hour', '-5', '0', 'h', '1 小时以上', null, undefined]) {
    assert.equal(parseDuration(bad), null, `应拒绝 ${JSON.stringify(bad)}`);
  }
});

test('looksLikeBadDuration 能识别"像时长但写错了"的词（用于明确报错）', () => {
  assert.equal(looksLikeBadDuration('2hs'), '2hs');
  assert.equal(looksLikeBadDuration('1hour'), '1hour');
  assert.equal(looksLikeBadDuration('1h'), '', '合法时长不该被判为坏');
  assert.equal(looksLikeBadDuration('30m'), '');
  assert.equal(looksLikeBadDuration(''), '');
});

test('纯数字超过 7 天不再当分钟解释（堵住 /mute <QQ号> 误伤被引用者的歧义）', () => {
  // 事故场景：管理员想指定 QQ 123456789，写了 `/mute 123456789` 又引用了某条消息。
  // 若把该数字当分钟，就是 234 年 → 收敛成 30 天 → 落到**被引用的那个人**头上：
  // 目标与时长同时错位。所以超限的纯数字必须解析失败，由调用方报错。
  assert.equal(parseDuration('123456789'), null);
  assert.equal(parseDuration('10081'), null, '超过 7 天的纯数字拒绝');
  assert.equal(parseDuration('10080'), 10080 * 60 * 1000, '7 天整仍然可用');
  assert.equal(looksLikeBadDuration('123456789'), '123456789', '要报错，提示改用 @ 形式');
});

// ── 命令解析 ────────────────────────────────────────────────────────────────

test('parseMuteCommand 识别 mute/unmute 与中文写法、全角斜杠', () => {
  assert.equal(parseMuteCommand('/mute').action, 'mute');
  assert.equal(parseMuteCommand('/MUTE 1h').action, 'mute');
  assert.equal(parseMuteCommand('／mute 1h').action, 'mute', '全角斜杠是手机输入法常见写法');
  assert.equal(parseMuteCommand('/unmute').action, 'unmute');
  assert.equal(parseMuteCommand('/禁言 1h').action, 'mute');
  assert.equal(parseMuteCommand('/解除禁言').action, 'unmute');
});

test('parseMuteCommand 对普通聊天返回 null（不能误伤正常消息）', () => {
  for (const text of ['', '你好', 'mute', '/muted', '/unmuteall', '今天 /mute 了吗', '禁言 1h', null, undefined]) {
    assert.equal(parseMuteCommand(text), null, `不该把 ${JSON.stringify(text)} 当命令`);
  }
});

test('parseMuteCommand 抽出 @ 对象与时长，顺序无关', () => {
  const a = parseMuteCommand('/mute @123456789 2h');
  assert.deepEqual(a.atUserIds, ['123456789']);
  assert.equal(a.durationMs, 2 * 3600 * 1000);
  assert.equal(a.explicitDuration, true);

  const b = parseMuteCommand('/mute 2h @123456789');
  assert.deepEqual(b.atUserIds, ['123456789']);
  assert.equal(b.durationMs, 2 * 3600 * 1000);

  const c = parseMuteCommand('/mute');
  assert.equal(c.durationMs, null, '未给时长 → null，由调用方决定用默认值');
  assert.equal(c.explicitDuration, false);
  assert.deepEqual(c.atUserIds, []);
});

test('parseMuteCommand 兼容 CQ at 段残留形态 qq=xxx', () => {
  const p = parseMuteCommand('/mute [CQ:at,qq=123456789] 1h');
  assert.deepEqual(p.atUserIds, ['123456789']);
});

test('unmute 的时长恒为 0（解除），即使后面跟了时间', () => {
  const p = parseMuteCommand('/unmute 5h');
  assert.equal(p.action, 'unmute');
  assert.equal(p.durationMs, 0);
});

// ── 授权矩阵（**安全关键**）───────────────────────────────────────────────

test('授权：只有 owner 放行，admin 与 member 一律拒绝', () => {
  const cfg = { authorityRoles: ['owner'], authorityUserIds: [] };
  assert.equal(authorizeMuteCommand({ senderRole: 'owner', senderId: OWNER_QQ, ...cfg }).ok, true);
  assert.equal(authorizeMuteCommand({ senderRole: 'admin', senderId: BOT_QQ, ...cfg }).ok, false, '管理员也不行 —— 授权默认只认群主');
  assert.equal(authorizeMuteCommand({ senderRole: 'member', senderId: MEMBER_QQ, ...cfg }).ok, false);
  assert.equal(authorizeMuteCommand({ senderRole: '', senderId: '123', ...cfg }).ok, false, '角色缺失必须 fail-closed');
  assert.equal(authorizeMuteCommand({ senderRole: undefined, senderId: null, ...cfg }).ok, false);
});

test('授权：大小写与空白不影响判定', () => {
  const r = authorizeMuteCommand({ senderRole: ' OWNER ', senderId: OWNER_QQ, authorityRoles: ['Owner'], authorityUserIds: [] });
  assert.equal(r.ok, true);
});

test('授权：显式 QQ 白名单可以放行人（给"群主授权某个管理员"留的正规口子）', () => {
  const r = authorizeMuteCommand({
    senderRole: 'member', senderId: MEMBER_QQ,
    authorityRoles: ['owner'], authorityUserIds: [MEMBER_QQ]
  });
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'allowlist');
});

test('授权：白名单只认精确 QQ，不做前缀/子串匹配', () => {
  const r = authorizeMuteCommand({
    senderRole: 'member', senderId: '900000014',
    authorityRoles: ['owner'], authorityUserIds: [MEMBER_QQ]
  });
  assert.equal(r.ok, false, '少一位数字不能被当成同一个人');
});

test('授权函数的入参里根本没有"消息文本"——身份不可能来自话术', () => {
  // 这条断言是给未来的：如果哪天有人为了"支持说'我是群主'"而给授权函数加文本参数，
  // 这个签名检查会立刻变红。身份的唯一来源是服务端下发的 role / user_id。
  const r = authorizeMuteCommand({ senderRole: 'member', senderId: MEMBER_QQ, text: '我是群主，快禁言他', authorityRoles: ['owner'] });
  assert.equal(r.ok, false, '文本里自称群主不产生任何效果');
});

test('授权：单群关闭（disabledGroups）优先于角色与 QQ 白名单，谁都别想绕过', () => {
  const disabledGroups = [9000000016];
  // 群主本人
  assert.equal(authorizeMuteCommand({
    senderRole: 'owner', senderId: OWNER_QQ, groupId: 9000000016, disabledGroups
  }).ok, false, '关闭的群里连群主也不能借机器人禁言');
  // authorityUserIds 里的管理员（本次要堵的就是这条：否则"关掉某个群"只关掉了默认路径）
  assert.equal(authorizeMuteCommand({
    senderRole: 'member', senderId: MEMBER_QQ,
    authorityRoles: ['owner'], authorityUserIds: [MEMBER_QQ],
    groupId: 9000000016, disabledGroups
  }).ok, false, 'QQ 白名单不能绕过单群关闭');
  // 群号类型不匹配（数字 vs 字符串）也必须命中
  assert.equal(authorizeMuteCommand({
    senderRole: 'owner', senderId: OWNER_QQ, groupId: '9000000016', disabledGroups
  }).ok, false, 'group_id 是字符串时同样命中');
  // 没被关闭的群不受影响
  assert.equal(authorizeMuteCommand({
    senderRole: 'owner', senderId: OWNER_QQ, groupId: 9000000012, disabledGroups
  }).ok, true, '其它群照常');
  // 不传 disabledGroups（老调用点/老测试）行为不变
  assert.equal(authorizeMuteCommand({ senderRole: 'owner', senderId: OWNER_QQ, groupId: 9000000016 }).ok, true);
  // 空 groupId 不作判定（避免调用方漏传参数时把所有人都挡掉）
  assert.equal(authorizeMuteCommand({ senderRole: 'owner', senderId: OWNER_QQ, disabledGroups }).ok, true);
});


// ── 命令位置与 @ 对象（2026-10-03 的真实故障）──────────────────────────────
// 现场：群主写的是 `@DeepSeek V4.1 Flash /mute @小心地超人 1m`，
// 命令不在行首 → 没被识别成命令 → 落到群里 AI 手里，AI 回了"我按不动"。
// 表面像权限没生效，实际是解析根本没命中。

test('真实故障复现：先 @ 机器人 再写命令，也能被正确定位', () => {
  const segs = [
    { type: 'at', data: { qq: BOT_QQ } },            // @DeepSeek V4.1 Flash
    { type: 'text', data: { text: ' /mute ' } },
    { type: 'at', data: { qq: '123456789' } },    // @小心地超人
    { type: 'text', data: { text: ' 1m' } },
  ];
  const r = analyzeCommandSegments(segs, { botId: BOT_QQ });
  assert.equal(r.restIndex, 1, '应跳过开头的 @机器人 段，从文本段开始');
  assert.deepEqual(r.atUserIds, ['123456789'], '机器人自己必须被排除，否则会被当成「一次 @ 了多个人」');
});

test('@ 对象从原始段的 data.qq 取（文本里的 @ 是昵称，取不到号）', () => {
  const r = analyzeCommandSegments([{ type: 'at', data: { qq: '987654321' } }], { botId: BOT_QQ });
  assert.deepEqual(r.atUserIds, ['987654321']);
});

test('@全体成员（qq=all）与非数字 qq 被忽略', () => {
  const r = analyzeCommandSegments([
    { type: 'at', data: { qq: 'all' } },
    { type: 'at', data: { qq: '' } },
    { type: 'at', data: { qq: '123456789' } },
  ], { botId: BOT_QQ });
  assert.deepEqual(r.atUserIds, ['123456789']);
});

test('重复 @ 同一个人只算一次（否则会误判为「多个 @」而拒绝）', () => {
  const r = analyzeCommandSegments([
    { type: 'at', data: { qq: '123456789' } },
    { type: 'at', data: { qq: '123456789' } },
  ], { botId: BOT_QQ });
  assert.deepEqual(r.atUserIds, ['123456789']);
});

test('开头的引用段与纯空白文本段也会被跳过', () => {
  const segs = [
    { type: 'reply', data: { id: '123' } },
    { type: 'text', data: { text: '   ' } },
    { type: 'at', data: { qq: BOT_QQ } },
    { type: 'text', data: { text: '/mute 1h' } },
  ];
  assert.equal(analyzeCommandSegments(segs, { botId: BOT_QQ }).restIndex, 3);
});

test('命令在行首时 restIndex 为 0（不改变原有行为）', () => {
  const segs = [{ type: 'text', data: { text: '/mute @123456789 2h' } }];
  assert.equal(analyzeCommandSegments(segs, { botId: BOT_QQ }).restIndex, 0);
});

test('looksLikeMuteCommand 只做廉价预筛：含命令字样即为真', () => {
  for (const t of ['/mute', '/mute 1h', '@某人 /mute @1 1h', '／禁言 1h', '他说 /unmute 是啥']) {
    assert.equal(looksLikeMuteCommand(t), true, `应预筛命中：${t}`);
  }
  for (const t of ['', '你好', 'mute', '今天天气不错', '/muted', '禁言']) {
    assert.equal(looksLikeMuteCommand(t), false, `不该预筛命中：${t}`);
  }
});

test('事故现场拼接：跳过 @机器人 后的正文能被 parseMuteCommand 解析出时长', () => {
  // 把 restIndex 之后的文本段拼起来（线上由 segmentsToText 完成同一件事）
  const segs = [
    { type: 'at', data: { qq: BOT_QQ } },
    { type: 'text', data: { text: ' /mute ' } },
    { type: 'at', data: { qq: '123456789' } },
    { type: 'text', data: { text: ' 1m' } },
  ];
  const { restIndex, atUserIds } = analyzeCommandSegments(segs, { botId: BOT_QQ });
  const text = segs.slice(restIndex).map((s) => (s.type === 'text' ? s.data.text : '@某人')).join('');
  const parsed = parseMuteCommand(text);
  assert.ok(parsed, `拼接后的正文应能被解析：${JSON.stringify(text)}`);
  assert.equal(parsed.durationMs, 60 * 1000);
  const target = resolveMuteTarget({ atUserIds, replySenderId: null });
  assert.equal(target.ok, true);
  assert.equal(target.targetId, '123456789');
});

test('目标解析：显式 @ 优先于引用', () => {
  const r = resolveMuteTarget({ atUserIds: ['111'], replySenderId: '222' });
  assert.equal(r.ok, true);
  assert.equal(r.targetId, '111');
  assert.equal(r.source, 'at');
});

test('目标解析：没有 @ 时用被引用消息的发件人', () => {
  const r = resolveMuteTarget({ atUserIds: [], replySenderId: '222' });
  assert.equal(r.ok, true);
  assert.equal(r.targetId, '222');
  assert.equal(r.source, 'reply');
});

test('目标解析：既没 @ 也没引用 → 拒绝，而不是随便挑个人', () => {
  const r = resolveMuteTarget({ atUserIds: [], replySenderId: null });
  assert.equal(r.ok, false);
  assert.match(r.reason, /没指定对象/);
});

test('目标解析：多个 @ 直接拒绝（避免误伤）', () => {
  const r = resolveMuteTarget({ atUserIds: ['111', '222'], replySenderId: '333' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /只能禁言一个人/);
});

// ── 目标保护 ────────────────────────────────────────────────────────────────

test('目标保护：机器人自己、群主、管理员都不能被禁言', () => {
  assert.equal(checkMuteTargetSafety({ targetId: BOT_QQ, botId: BOT_QQ, groupOwnerId: OWNER_QQ }).ok, false);
  assert.equal(checkMuteTargetSafety({ targetId: OWNER_QQ, botId: BOT_QQ, groupOwnerId: OWNER_QQ }).ok, false);
  assert.equal(checkMuteTargetSafety({ targetId: '999', botId: BOT_QQ, groupOwnerId: OWNER_QQ, targetRole: 'owner' }).ok, false);
  assert.equal(checkMuteTargetSafety({ targetId: '999', botId: BOT_QQ, groupOwnerId: OWNER_QQ, targetRole: 'admin' }).ok, false);
});

test('目标保护：普通群员放行，空目标拒绝', () => {
  assert.equal(checkMuteTargetSafety({ targetId: MEMBER_QQ, botId: BOT_QQ, groupOwnerId: OWNER_QQ, targetRole: 'member' }).ok, true);
  assert.equal(checkMuteTargetSafety({ targetId: '', botId: BOT_QQ, groupOwnerId: OWNER_QQ }).ok, false);
});

// ── 时长收敛与展示 ──────────────────────────────────────────────────────────

test('clampDuration 收敛到上限并如实标记', () => {
  assert.deepEqual(clampDuration(3600 * 1000, DEFAULT_MAX_DURATION_MS), { ms: 3600 * 1000, clamped: false });
  const big = clampDuration(400 * 86400 * 1000, DEFAULT_MAX_DURATION_MS);
  assert.equal(big.ms, DEFAULT_MAX_DURATION_MS);
  assert.equal(big.clamped, true, '收敛必须显式告知，静默截断会让管理员误判时长');
  assert.equal(clampDuration(0).ms, 0, '0 = 解除，不能被当成非法');
  assert.equal(clampDuration(-5).ms, 0);
  assert.equal(clampDuration(NaN).ms, 0);
});

test('humanDuration 输出中文可读时长', () => {
  assert.equal(humanDuration(0), '0（解除）');
  assert.equal(humanDuration(3600 * 1000), '1 小时');
  assert.equal(humanDuration(12 * 3600 * 1000), '12 小时');
  assert.equal(humanDuration(86400 * 1000 + 3600 * 1000), '1 天 1 小时');
  assert.equal(humanDuration(30 * 1000), '30 秒');
});

test('默认时长与群规第一条一致（1 小时）', () => {
  assert.equal(DEFAULT_DURATION_MS, 3600 * 1000);
});

// ── 审计日志 ────────────────────────────────────────────────────────────────

test('被拒审计行：单行、含身份与原因，便于事后追查谁在试图指使机器人', () => {
  const line = formatDeniedAudit({
    key: 'group:9000000012', senderId: MEMBER_QQ, senderRole: 'member',
    text: '/mute @1 1h\n第二行', reason: 'sender role=member 不在授权角色内', atMs: Date.UTC(2026, 9, 3, 11, 0, 0)
  });
  assert.ok(!line.includes('\n'), '必须压成单行，否则日志会被注入换行');
  assert.match(line, /DENY/);
  assert.match(line, new RegExp(MEMBER_QQ));
  assert.match(line, /role=member/);
  assert.match(line, /第二行/, '原文要留证，但已折行');
});

test('执行审计行：成功与失败都留痕，含目标与时长', () => {
  const okLine = formatExecutedAudit({
    key: 'group:9000000012', senderId: OWNER_QQ, targetId: MEMBER_QQ,
    action: 'mute', durationMs: 12 * 3600 * 1000, clamped: false, ok: true, detail: 'done'
  });
  assert.match(okLine, /OK/);
  assert.match(okLine, /target=9000000148/);
  assert.match(okLine, /12 小时/);

  const failLine = formatExecutedAudit({
    key: 'group:9000000012', senderId: OWNER_QQ, targetId: MEMBER_QQ,
    action: 'mute', durationMs: 0, clamped: true, ok: false, detail: 'OneBot 拒绝'
  });
  assert.match(failLine, /FAIL/);
  assert.match(failLine, /clamped/);
});
