// 群聊服务时限（config.json → allow.groupUntil）的离线回归。
//
// 这条规则守的是"运营方说服务到某天为止"的承诺：到点必须**自动**失效，
// 不能靠人工回来删白名单（半夜到点、人不在、忘了，都会变成"说好了停却还在群里说话"）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeServiceWindow, formatRemaining, parseDeadline, serviceWindowExpired } from '../src/service-window.js';

const GID = '9000000012';
const cfg = (until) => ({ allow: { groups: [Number(GID)], groupUntil: until ? { [GID]: until } : {} } });
const at = (iso) => Date.parse(iso);

test('parseDeadline：合法 ISO 解析成时间戳，非法/空返回 null', () => {
  assert.equal(parseDeadline('2026-10-08T00:30:00+08:00'), at('2026-10-08T00:30:00+08:00'));
  for (const bad of ['', '   ', 'not-a-date', '2026-13-45T00:00:00Z', null, undefined, {}]) {
    assert.equal(parseDeadline(bad), null, `应拒绝 ${JSON.stringify(bad)}`);
  }
});

test('到期前照常服务，到点那一刻起失效（边界按 >= 判定）', () => {
  const c = cfg('2026-10-08T00:30:00+08:00');
  assert.equal(serviceWindowExpired('group', GID, c, at('2026-10-07T23:59:59+08:00')), false);
  assert.equal(serviceWindowExpired('group', GID, c, at('2026-10-08T00:29:59+08:00')), false);
  assert.equal(serviceWindowExpired('group', GID, c, at('2026-10-08T00:30:00+08:00')), true, '到点即失效');
  assert.equal(serviceWindowExpired('group', GID, c, at('2026-10-09T00:00:00+08:00')), true);
});

test('时限只作用于群聊：私聊与非本群号都不受影响', () => {
  const c = cfg('2026-10-08T00:30:00+08:00');
  const late = at('2026-11-01T00:00:00+08:00');
  assert.equal(serviceWindowExpired('private', '9000000148', c, late), false, '私聊永远不受群聊时限影响');
  assert.equal(serviceWindowExpired('group', '123456789', c, late), false, '别的群号没有时限');
});

test('没配时限 / 时间非法 → 不算到期（退回普通白名单语义，不误伤）', () => {
  const late = at('2030-01-01T00:00:00+08:00');
  assert.equal(serviceWindowExpired('group', GID, cfg(''), late), false);
  assert.equal(serviceWindowExpired('group', GID, cfg(null), late), false);
  assert.equal(serviceWindowExpired('group', GID, cfg('不是时间'), late), false);
  assert.equal(serviceWindowExpired('group', GID, { allow: { groups: [Number(GID)] } }, late), false);
  assert.equal(serviceWindowExpired('group', GID, null, late), false);
});

test('describeServiceWindow / formatRemaining：诊断用的剩余时长', () => {
  const c = cfg('2026-10-08T00:30:00+08:00');
  const d = describeServiceWindow(GID, c, at('2026-10-06T20:00:00+08:00'));
  assert.equal(d.expired, false);
  assert.equal(formatRemaining(d.leftMs), '28 小时');
  const expired = describeServiceWindow(GID, c, at('2026-10-08T10:00:00+08:00'));
  assert.equal(expired.expired, true);
  assert.equal(formatRemaining(expired.leftMs), '0 分钟');
  assert.equal(describeServiceWindow(GID, cfg(null), Date.now()), null, '没配时限返回 null');
});
