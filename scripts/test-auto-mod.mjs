// 违规内容识别与**上报**的离线回归。
//
// 这组用例的**反例全部来自真实群流量**（近 1.2 万条消息的实测假阳性）：
// 关键词即命中的朴素方案在这批数据上命中 26 次、真阳性 0。那些样本现在被写成断言，
// 谁把规则改松（比如去掉"必须含链接"、或往词表里加"平台"这种普通词），这里立刻变红。
//
// ⚠️ 另有一类断言专门守着"**不处罚**"这条边界：命中之后只能上报，
// 模块里不允许出现禁言/踢人相关字段（见文件末尾）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  DEFAULT_HARD_PATTERNS,
  compilePatterns,
  evaluateAutoMod,
  formatAutoModAudit,
  formatOwnerNotice,
  hasLinkLike
} from '../src/auto-mod.js';

const GID = '9000000012';
const BOT = '9000000011';
const OWNER = '900000013';
const SPAMMER = '123456789';

function cfg(overrides = {}) {
  return { enabled: true, groups: [GID], linkRequired: true, ...overrides };
}
function ev(text, overrides = {}) {
  return evaluateAutoMod({ text, cfg: cfg(overrides.cfg), groupId: overrides.groupId ?? GID, senderId: overrides.senderId ?? SPAMMER, senderRole: overrides.senderRole ?? 'member', botId: BOT, exemptUserIds: overrides.exemptUserIds ?? [] });
}

// ── 真实假阳性：这些**绝对不能**被上报（否则烦的是自己人）────────────────────

test('反例①：SnowLuma 自己的状态播报（曾命中「平台」×17）', () => {
  const status = 'SnowLuma 状态\n版本: 1.14.20\n平台: win32-x64\n运行时长: 1分钟 15秒';
  assert.equal(ev(status, { senderId: BOT }).action, 'none');
});

test('反例②：群友转发的反诈宣传（曾命中「约炮」×6）', () => {
  const psa = '持续强化高校反诈防线，聚焦学生高频受骗场景，通过班级群、校园公众号、短视频等渠道推送反诈案例与防范常识。强化警校联动，加大线上反诈提醒频次，重点预警约炮刷单、游戏交易、冒充客服及机票退改签等骗局。';
  assert.equal(ev(psa).action, 'none');
});

test('反例③：朋友间玩笑「开始约炮了」', () => {
  assert.equal(ev('他妈真喝大了，开始约炮了').action, 'none');
});

test('反例④：善意的风险提醒「约炮平台和借钱平台」', () => {
  assert.equal(ev('约炮平台和借钱平台').action, 'none');
});

test('反例⑤：机器人解释 MJ 的歧义（曾命中「大麻」）', () => {
  assert.equal(ev('国外 MJ 一般是迈克尔杰克逊，别的地方还有大麻的意思', { senderId: BOT }).action, 'none');
});

test('反例⑥：词表里绝不能出现「平台」「博彩」这类普通词', () => {
  for (const w of ['平台', '博彩', '彩票', '提现', '下注']) {
    assert.ok(!DEFAULT_HARD_PATTERNS.includes(w), `「${w}」太普通，进了词表必然误报（实测「平台」命中 17 次全是自己人）`);
  }
});

// ── 真广告：必须上报 ────────────────────────────────────────────────────────

test('真广告：赌博站话术 + 链接 → 上报', () => {
  const r = ev('【威尼斯人】新用户首存送彩金，真人荷官在线发牌 https://vip-abc.xyz/reg?code=1');
  assert.equal(r.action, 'report');
  assert.match(r.reason, /威尼斯人|首存/);
});

test('真广告：色情引流 + 微信号 → 上报', () => {
  assert.equal(ev('同城上门服务 加微信：abc123 全套服务').action, 'report');
});

test('真广告：毒品货源话术 + 联系方式 → 上报', () => {
  assert.equal(ev('一手货源 冰毒 摇头丸 需要加V：x9k2').action, 'report');
});

// ── 触发条件的核心：必须同时含链接 ──────────────────────────────────────────

test('只有广告词、没有链接 → 不上报（这正是把误报压到 0 的那一刀）', () => {
  const r = ev('我刚才看新闻说威尼斯人那边又出事了');
  assert.equal(r.action, 'none');
  assert.match(r.reason, /without-link/);
});

test('只有链接、没有广告词 → 不上报（群里 25.9% 的消息都带链接）', () => {
  assert.equal(hasLinkLike('看看这个 https://example.com/a'), true);
  assert.equal(ev('看看这个 https://example.com/a').action, 'none');
});

test('linkRequired=false 时放宽为只匹配词表（管理员显式选择，才允许）', () => {
  assert.equal(ev('威尼斯人', { cfg: { linkRequired: false } }).action, 'report');
});

// ── 豁免与作用域 ────────────────────────────────────────────────────────────

test('机器人自己 / 群主 / 管理员 一律豁免（不给自己人添噪音）', () => {
  const ad = '威尼斯人首存送彩金 https://x.xyz';
  assert.equal(ev(ad, { senderId: BOT }).action, 'none');
  assert.equal(ev(ad, { senderId: OWNER, senderRole: 'owner' }).action, 'none');
  assert.equal(ev(ad, { senderId: '999', senderRole: 'admin' }).action, 'none');
});

test('显式豁免名单生效', () => {
  const ad = '威尼斯人首存送彩金 https://x.xyz';
  assert.equal(ev(ad, { senderId: '555', exemptUserIds: ['555'] }).action, 'none');
  assert.equal(ev(ad, { senderId: '556', exemptUserIds: ['555'] }).action, 'report');
});

test('不在生效群列表内 → 不动（空列表也必须 fail-closed）', () => {
  const ad = '威尼斯人首存送彩金 https://x.xyz';
  assert.equal(ev(ad, { groupId: '900000015' }).action, 'none');
  assert.equal(ev(ad, { cfg: { groups: [] } }).action, 'none');
});

test('未启用 → 不动', () => {
  assert.equal(ev('威尼斯人首存 https://x.xyz', { cfg: { enabled: false } }).action, 'none');
});

// ── 健壮性 ──────────────────────────────────────────────────────────────────

test('坏正则只跳过自己，不废掉整张表', () => {
  const list = compilePatterns(['([', '威尼斯人']);
  assert.equal(list.length, 1, '非法正则应被跳过');
  assert.equal(list[0].source, '威尼斯人');
  assert.equal(ev('威尼斯人首存 https://x.xyz', { cfg: { patterns: ['([', '威尼斯人'] } }).action, 'report');
});

test('管理员自定义 patterns 完全覆盖默认表', () => {
  assert.equal(ev('本群专属暗号 加微信 vx:aaa', { cfg: { patterns: ['专属暗号'] } }).action, 'report');
  assert.equal(ev('威尼斯人首存 https://x.xyz', { cfg: { patterns: ['专属暗号'] } }).action, 'none');
});

test('空消息 / 空白消息不触发', () => {
  assert.equal(ev('').action, 'none');
  assert.equal(ev('   ').action, 'none');
});

// ── 审计与上报文案 ──────────────────────────────────────────────────────────

test('审计行单行化，标签是 REPORT，失败标记 FAIL', () => {
  const base = { key: `group:${GID}`, senderId: SPAMMER, senderRole: 'member', pattern: '威尼斯人', reason: '命中广告特征', action: 'report' };
  const okLine = formatAutoModAudit({ ...base, ok: true });
  const failLine = formatAutoModAudit({ ...base, ok: false, detail: '私聊发送失败' });
  assert.match(okLine, /REPORT/);
  assert.match(failLine, /FAIL/);
  for (const line of [okLine, failLine]) assert.ok(!line.includes('\n'), '审计行必须单行');
  assert.match(okLine, new RegExp(SPAMMER));
});

test('上报文案：措辞是「疑似」、给出原文、并明确说明没有处罚', () => {
  const text = formatOwnerNotice({
    groupLabel: '群 9000000012', senderLabel: '某人', senderId: SPAMMER,
    reason: '命中广告特征「威尼斯人」 + 链接', excerpt: '【威尼斯人】首存送彩金 https://x.xyz'
  });
  assert.match(text, /疑似/, '定性由人做，机器人不该替人下结论');
  assert.match(text, /没有/, '必须写明机器人没有做任何处罚');
  assert.match(text, /原文：/);
  assert.match(text, /\/mute/, '要告诉人下一步该怎么做');
});

// ── 边界：这个模块**不允许**产生处罚能力 ────────────────────────────────────

test('src/auto-mod.js 里不允许出现任何处罚相关代码（防止有人以后偷偷接回去）', () => {
  const src = fs.readFileSync(fileURLToPath(new URL('../src/auto-mod.js', import.meta.url)), 'utf8');
  for (const banned of ['set_group_ban', 'set_group_kick', 'durationMs', 'muteDuration']) {
    assert.ok(!src.includes(banned), `auto-mod.js 里出现了「${banned}」—— 这个模块只负责识别与上报，处罚必须走群主的手动命令`);
  }
});

test('上报动作的返回值只有 none / report 两种', () => {
  const seen = new Set();
  for (const t of ['', '你好', '威尼斯人首存 https://x.xyz', '威尼斯人']) seen.add(ev(t).action);
  assert.deepEqual([...seen].sort(), ['none', 'report']);
});
