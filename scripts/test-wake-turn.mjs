import test from 'node:test';
import assert from 'node:assert/strict';
import { abortNotice, shouldCountWakeTurn, sleepTimerSegment, appendWakeSnapshot, createStopIntentTracker } from '../src/wake-turn.js';

test('only an explicitly identified user stop receives a notice', () => {
  assert.equal(abortNotice('user-stop'), '⏹️ 已停止');
  for (const reason of [null, 'directed-wake', 'maintenance', 'unknown']) assert.equal(abortNotice(reason), null);
});

test('stop intent belongs to one session and one turn', () => {
  const tracker = createStopIntentTracker();
  tracker.mark('s1', 10, 'user-stop');
  assert.equal(tracker.take('s2', 10), null);
  assert.equal(tracker.take('s1', 11), null);
  assert.equal(abortNotice(tracker.take('s1', 10)), '⏹️ 已停止');
  assert.equal(tracker.take('s1', 10), null);
});

test('aborted and failed turns do not count as completed wake attempts', () => {
  assert.equal(shouldCountWakeTurn({ kind: 'completed' }), true);
  assert.equal(shouldCountWakeTurn({ kind: 'completed' }, true), false);
  assert.equal(shouldCountWakeTurn({ kind: 'aborted' }), false);
  assert.equal(shouldCountWakeTurn({ kind: 'error' }), false);
});

test('sleep timer uses the Node maximum while respecting shorter delays', () => {
  assert.equal(sleepTimerSegment(60000), 60000);
  assert.equal(sleepTimerSegment(3_000_000_000), 2 ** 31 - 1);
  assert.equal(sleepTimerSegment(Infinity), 2 ** 31 - 1);
});

test('wake snapshot retains pagination and acknowledgement instructions', () => {
  const snapshot = { messages: [{ seq: 3, text: 'hello' }], readThroughSeq: 3, partial: true };
  const prompt = appendWakeSnapshot('base', snapshot);
  assert.match(prompt, /partial=true/);
  assert.match(prompt, /afterSeq=readThroughSeq/);
  assert.match(prompt, /throughSeq/);
  assert.ok(prompt.includes(JSON.stringify(snapshot)));
  assert.equal(appendWakeSnapshot('base', null), 'base');
});
