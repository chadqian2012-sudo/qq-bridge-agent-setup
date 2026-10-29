// 定时开关（tools/ai-night-schedule.ps1）决策表的离线回归。
//
// 为什么值得单独一个测试：这个脚本只在夜里跑，写错了没人当场发现；
// 而且窗口边界很容易写反 —— 作者第一版就把 01:00-07:30 的不跨午夜区间写成了 -or，
// 结果 07:30、08:00 都被算成"该暂停"（AI 整个白天都不醒）。干跑钩子
// （AI_SCHED_NOW / AI_SCHED_DRY）就是为这种时候留的。
//
// 纯离线：只跑 PowerShell 的 dry-run 分支，不碰桥接、不发任何请求。
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'tools', 'ai-night-schedule.ps1');
const PS = 'powershell.exe';

/** 跑一次干跑，返回 `{ window, paused }`。 */
function decide(at) {
  const out = execFileSync(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, AI_SCHED_NOW: at, AI_SCHED_DRY: '1' },
    timeout: 30000
  });
  const window = /window=([^\s]+)/.exec(out)?.[1];
  const paused = /desiredPaused=(\w+)/.exec(out)?.[1];
  assert.ok(window && paused, `干跑输出无法解析：${JSON.stringify(out)}`);
  return { window, paused: paused === 'True' };
}

test('今天是假期尾巴：今晚（10-04）不暂停，明天 01:00 才进入新窗口', () => {
  assert.equal(decide('2026-10-04 22:00').paused, false);
  assert.equal(decide('2026-10-04 23:30').paused, false, '10-04 23:30 仍按"假期 24 小时运行"');
  assert.equal(decide('2026-10-05 00:30').paused, false, '10-05 00:30 还没到 01:00');
});

test('10-05 ~ 10-08：01:00 暂停、07:30 恢复（窗口内不醒）', () => {
  assert.equal(decide('2026-10-05 01:00').paused, true);
  assert.equal(decide('2026-10-05 07:00').paused, true);
  assert.equal(decide('2026-10-05 07:29').paused, true, '07:29 还在窗口里');
  assert.equal(decide('2026-10-05 07:30').paused, false, '07:30 必须醒');
  assert.equal(decide('2026-10-05 08:00').paused, false);
  assert.equal(decide('2026-10-08 01:30').paused, true, '10-08 当天仍按 01:00-07:30');
  assert.equal(decide('2026-10-08 12:00').paused, false);
});

test('10-09 起回到基础规则 23:00-07:00', () => {
  assert.equal(decide('2026-10-09 00:30').paused, true);
  assert.equal(decide('2026-10-09 07:00').paused, false);
  assert.equal(decide('2026-10-09 23:30').paused, true);
  assert.equal(decide('2026-10-09 12:00').paused, false);
});
