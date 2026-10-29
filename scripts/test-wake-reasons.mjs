// 唤醒原因分类的离线回归。
//
// 这个模块守的是一条**行为边界**：有人在直接跟 AI 说话时必须回，随机瞄一眼可以不回。
// 之前正因为没有这条界线，被 @ 了也在提示词里邀请它潜水，群友投诉"爱答不理"。
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkWakeRateLimit, describeWakeReason, isDirectedWakeReason, isPokeWakeReason, pickWakeTrigger, takeHighestPriorityWake, WAKE_PRIORITY, wakePriority } from '../src/wake-reasons.js';

// ── 触发判定：定向必须优先于 anyMessage ─────────────────────────────────────
//
// 这条顺序是"被 @ 后反应速度"的一部分，踩过一次：
// 活跃模式（anyMessage）下先判 anyMessage，一条 @ 就被归成普通消息 ——
// 用 1/分钟 的普通配额（而不是 3/分钟的定向配额，@ 会被限流丢掉）、
// 提示词里也不会带【别等，直接回】（模型先去等静默窗口）。

test('活跃模式下，@ 必须判成 atMention（定向），不能退化成 anyMessage', () => {
  const triggers = { anyMessage: true, atMention: true, nameMention: true, question: true, probability: 0.035 };
  assert.equal(pickWakeTrigger({ triggers, atSelf: true }), 'atMention');
  // 引用机器人自己的消息同样算定向
  assert.equal(pickWakeTrigger({ triggers, quoteTargetIsSelf: true }), 'atMention');
  assert.equal(pickWakeTrigger({ triggers }), 'anyMessage', '没被点名的普通消息才走 anyMessage');
});

test('活跃模式下，叫名字 / 直接提问也判成定向', () => {
  const triggers = { anyMessage: true, atMention: true, nameMention: true, question: true };
  assert.equal(pickWakeTrigger({ triggers, textContent: '大肥鱼在吗', selfNickname: '大肥鱼' }), 'nameMention');
  assert.equal(pickWakeTrigger({ triggers, plainContent: '你怎么看', isDirectedAtAi: () => true }), 'question');
});

test('关掉 @ 触发时，@ 不会凭空变成定向（尊重会话 trigger 开关）', () => {
  const triggers = { anyMessage: true, atMention: false, nameMention: false, question: false };
  assert.equal(pickWakeTrigger({ triggers, atSelf: true }), 'anyMessage');
});

test('触发判定的兜底顺序：关键词 → 指定成员 → 概率 → 不唤醒', () => {
  assert.equal(pickWakeTrigger({ triggers: { keywords: ['小鲸鱼'] }, plainContent: '小鲸鱼' }), 'keyword:小鲸鱼');
  assert.equal(pickWakeTrigger({ triggers: { speakerIds: [7] }, speakerId: '7', speakerLabel: '某人' }), 'speaker:某人');
  assert.equal(pickWakeTrigger({ triggers: { probability: 1 } }), 'probability');
  assert.equal(pickWakeTrigger({ triggers: { probability: 0 } }), null);
  assert.equal(pickWakeTrigger({ triggers: {} }), null);
});

test('私聊任何消息都唤醒（不看触发器）', () => {
  assert.equal(pickWakeTrigger({ triggers: {}, isPrivate: true }), 'private');
});

// ── 必须回 ──────────────────────────────────────────────────────────────────

test('有人直接跟它说话 → 必须回', () => {
  for (const r of ['atMention', 'nameMention', 'question', 'private']) {
    assert.equal(isDirectedWakeReason(r), true, `${r} 应该要求必须回`);
  }
});

test('带前缀的原因（关键词 / 指定成员）也要求必须回', () => {
  assert.equal(isDirectedWakeReason('keyword:大肥鱼'), true);
  assert.equal(isDirectedWakeReason('keyword:DeepSeek'), true);
  assert.equal(isDirectedWakeReason('speaker:某个群友'), true);
});

// ── 可以不回 ────────────────────────────────────────────────────────────────

test('概率触发 / 睡够自然醒 / 冷场机会 / 回访 → 不强制回（保住「不要没话硬接」）', () => {
  for (const r of ['probability', 'timeout', 'proactiveCheck', 'replyCheck', 'bootstrap']) {
    assert.equal(isDirectedWakeReason(r), false, `${r} 不该强制回`);
  }
});

test('拍一拍单独归类：可能拍的是别人，不能一律强制', () => {
  assert.equal(isDirectedWakeReason('poke'), false);
  assert.equal(isPokeWakeReason('poke'), true);
  assert.equal(isPokeWakeReason('atMention'), false);
});

test('空值 / 脏值一律按"不强制"处理（fail-open，避免误伤正常潜水）', () => {
  for (const r of ['', '   ', null, undefined, 0, 'unknown-reason', 'keyword', 'speaker']) {
    assert.equal(isDirectedWakeReason(r), false, `${JSON.stringify(r)} 不该判定为必须回`);
  }
});

// ── 说明文案 ────────────────────────────────────────────────────────────────

test('describeWakeReason 把原因写成人话', () => {
  assert.match(describeWakeReason('atMention'), /@/);
  assert.match(describeWakeReason('nameMention'), /名字/);
  assert.match(describeWakeReason('question'), /问题/);
  assert.match(describeWakeReason('private'), /私聊/);
  assert.match(describeWakeReason('keyword:大肥鱼'), /大肥鱼/);
  assert.match(describeWakeReason('speaker:张三'), /张三/);
  assert.match(describeWakeReason('probability'), /概率/);
  // 未收录的原因也要有可读输出，不能是 undefined
  assert.equal(typeof describeWakeReason('某个新原因'), 'string');
  assert.ok(describeWakeReason('某个新原因').length > 0);
  assert.equal(typeof describeWakeReason(''), 'string');
});

// ── 优先级 & 积压队列取用 ───────────────────────────────────────────────────
// 会话繁忙时队列按优先级取，不按 FIFO —— 否则“被 @”会排在一堆 probability 后面等，
// 群里体感就是"@它半天不理"（2026-10-03 实测日志里真的发生过）。

test('优先级：有人直接说话 > 概率偷看', () => {
  assert.ok(wakePriority('atMention') > wakePriority('probability'));
  assert.ok(wakePriority('question') > wakePriority('probability'));
  assert.ok(wakePriority('keyword:大肥鱼') > wakePriority('probability'));
  assert.ok(wakePriority('private') > wakePriority('atMention'));
});

test('优先级：@ > 提问 > 关键词 > 回访 > 定时', () => {
  const order = ['private', 'atMention', 'question', 'speaker', 'nameMention', 'keyword', 'anyMessage', 'replyCheck', 'timeout', 'proactiveCheck'];
  for (let i = 1; i < order.length; i += 1) {
    assert.ok(wakePriority(order[i - 1]) > wakePriority(order[i]), `${order[i - 1]} 应高于 ${order[i]}`);
  }
});

test('未收录 / 空值的原因优先级为 0（和 probability 同级）', () => {
  assert.equal(wakePriority('probability'), 0);
  assert.equal(wakePriority('没见过的原因'), 0);
  assert.equal(wakePriority(''), 0);
  assert.equal(wakePriority(null), 0);
});

test('积压队列取用时，被 @ 会插到 probability 前面', () => {
  const q = [
    { reason: 'probability', seq: 1 },
    { reason: 'probability', seq: 2 },
    { reason: 'atMention', seq: 3 },
    { reason: 'probability', seq: 4 }
  ];
  const picked = takeHighestPriorityWake(q);
  assert.equal(picked.reason, 'atMention', '@ 必须被优先投递');
  assert.equal(picked.seq, 3);
  assert.equal(q.length, 3, '被摘掉的条目不能留在队列里');
  assert.ok(!q.some((x) => x.reason === 'atMention'));
});

test('取用后队列里的相对顺序保持稳定（不会饿死低优先级）', () => {
  const q = [{ reason: 'timeout' }, { reason: 'proactiveCheck' }, { reason: 'probability' }];
  assert.equal(takeHighestPriorityWake(q).reason, 'timeout');
  assert.equal(takeHighestPriorityWake(q).reason, 'proactiveCheck');
  assert.equal(takeHighestPriorityWake(q).reason, 'probability');
  assert.equal(takeHighestPriorityWake(q), null, '取空了应返回 null');
});

test('同分时取更早入队的那条（稳定，不饿死）', () => {
  const q = [{ reason: 'probability', seq: 10 }, { reason: 'probability', seq: 11 }];
  assert.equal(takeHighestPriorityWake(q).seq, 10);
});

test('兼容旧版本残留的纯字符串条目', () => {
  const q = ['probability', 'atMention'];
  const picked = takeHighestPriorityWake(q);
  assert.equal(picked.reason, 'atMention');
  assert.equal(picked.seq, 0);
  assert.deepEqual(q, ['probability']);
});

test('空队列 / 非数组输入返回 null，不抛错', () => {
  assert.equal(takeHighestPriorityWake([]), null);
  assert.equal(takeHighestPriorityWake(null), null);
  assert.equal(takeHighestPriorityWake(undefined), null);
  assert.equal(takeHighestPriorityWake('不是数组'), null);
});

test('WAKE_PRIORITY 表本身被冻结，防止运行时被悄悄改掉', () => {
  assert.ok(Object.isFrozen(WAKE_PRIORITY));
});

// ── 频率闸门：定向唤醒不能被全局配额丢掉 ────────────────────────────────────
// 现场（2026-10-03 实测日志）：`唤醒频率超限，跳过（nameMention）`
// —— 有人点了它的名字，却因为 60 秒内刚有过一次概率唤醒而**被整个丢掉**（不是延迟）。
// 注意：被闸门拦下不会补发，所以这是"叫它不理"的直接成因。

const T = 1_800_000_000_000; // 固定基准时刻

test('回归：概率唤醒占用全局配额后，@ / 名字 仍然放行', () => {
  const wakeTimes = [T - 30_000]; // 30 秒前刚有一次概率唤醒
  for (const reason of ['atMention', 'nameMention', 'question', 'private', 'keyword:大肥鱼']) {
    const v = checkWakeRateLimit({ reason, wakeTimes, directedTimes: [], now: T, maxPerMinute: 1 });
    assert.equal(v.skip, false, `${reason} 不该被全局配额丢掉`);
    assert.equal(v.recordDirected, true, `${reason} 应记入定向配额`);
  }
});

test('非定向唤醒仍然受全局每分钟配额限制', () => {
  const wakeTimes = [T - 30_000];
  for (const reason of ['probability', 'timeout', 'proactiveCheck', 'replyCheck']) {
    assert.equal(checkWakeRateLimit({ reason, wakeTimes, now: T, maxPerMinute: 1 }).skip, true, `${reason} 应受限`);
  }
  assert.equal(checkWakeRateLimit({ reason: 'probability', wakeTimes: [], now: T, maxPerMinute: 1 }).skip, false);
});

test('定向唤醒有自己的配额（默认 3/分钟），不是无限', () => {
  const directedTimes = [T - 40_000, T - 20_000, T - 5_000]; // 一分钟内已 3 次
  const v = checkWakeRateLimit({ reason: 'atMention', wakeTimes: [], directedTimes, now: T, maxDirectedPerMinute: 3 });
  assert.equal(v.skip, true, '第 4 次应被定向配额拦下（防止被刷 @ 烧钱）');
  assert.match(v.reason, /3/);

  // 自定义配额生效
  assert.equal(checkWakeRateLimit({ reason: 'atMention', directedTimes, now: T, maxDirectedPerMinute: 5 }).skip, false);
});

test('超过 60 秒的定向记录不再计入配额', () => {
  const directedTimes = [T - 61_000, T - 90_000, T - 120_000];
  assert.equal(checkWakeRateLimit({ reason: 'atMention', directedTimes, now: T, maxDirectedPerMinute: 3 }).skip, false);
});

test('每小时配额：maxWakePerHour=0 表示不限制', () => {
  const many = Array.from({ length: 50 }, (_, i) => T - i * 1000);
  assert.equal(checkWakeRateLimit({ reason: 'probability', wakeTimes: many, now: T, maxPerMinute: 0, maxPerHour: 0 }).skip, false);
  assert.equal(checkWakeRateLimit({ reason: 'probability', wakeTimes: many, now: T, maxPerMinute: 0, maxPerHour: 10 }).skip, true);
});

test('脏输入不抛错（缺失数组 / null / 非数字时间戳）', () => {
  assert.equal(checkWakeRateLimit({ reason: 'atMention', now: T }).skip, false);
  assert.equal(checkWakeRateLimit({ reason: 'probability', wakeTimes: null, now: T, maxPerMinute: 1 }).skip, false);
  assert.equal(checkWakeRateLimit({ reason: 'atMention', directedTimes: [null, 'x', NaN], now: T }).skip, false);
  assert.equal(checkWakeRateLimit({ reason: 'probability', wakeTimes: [], now: T, maxPerMinute: 1 }).skip, false);
});

test('定向配额至少为 1（配成 0 或负数时不至于把 @ 全掐死）', () => {
  const v = checkWakeRateLimit({ reason: 'atMention', directedTimes: [], now: T, maxDirectedPerMinute: 0 });
  assert.equal(v.skip, false);
});
