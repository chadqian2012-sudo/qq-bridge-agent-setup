import assert from 'node:assert/strict';
import test from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

test('an aborted DSH turn does not send a QQ stop notice or count as an inactive wake', async () => {
  const h = await bridgeHarness();
  try {
    h.setMode('reserved2');
    const sessionId = await h.ensureSession('group:456');
    const state = h.getSocialV2State('group:456');
    h.appendSocialV2Message('group:456', 'member', 'first', 'first', false, false, 'm1', [], '789', []);
    await h.sendWakePromptV2('group:456', 'question');
    assert.equal(h.calls.prompts.length, 1);
    h.appendSocialV2Message('group:456', 'member', 'follow-up', 'follow-up', false, false, 'm2', [], '789', []);
    state.pendingWakeReasons = [{ reason: 'atMention', seq: state.lastUnreadSeq }];
    state.wakeConfig.noActionCount = 0;
    let processed;
    const done = new Promise((resolve) => { processed = resolve; });
    h.api.events.mux = async function* () {
      yield { payload: { type: 'session/event', sessionId, event: { type: 'turn/start', data: { turn: 1 } } } };
      h.stopIntents.mark(sessionId, 1, 'directed-wake');
      yield { payload: { type: 'session/event', sessionId, event: { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } } } };
      processed();
      await new Promise(() => {});
    };
    void h.pumpMux();
    await Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(new Error('event processing timeout')), 2000))]);
    assert.equal(h.calls.sent.length, 0);
    assert.equal(state.wakeConfig.noActionCount, 0);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(h.calls.prompts.length, 2, 'pending directed wake must still be delivered');
  } finally { await h.close(); }
});

test('an explicitly attributed user stop reaches only the fixture QQ transport', async () => {
  const h = await bridgeHarness();
  try {
    h.setMode('reserved2');
    const sessionId = await h.ensureSession('group:456');
    let processed;
    const done = new Promise((resolve) => { processed = resolve; });
    h.api.events.mux = async function* () {
      yield { payload: { type: 'session/event', sessionId, event: { type: 'turn/start', data: { turn: 2 } } } };
      h.stopIntents.mark(sessionId, 2, 'user-stop');
      yield { payload: { type: 'session/event', sessionId, event: { type: 'turn/end', data: { turn: 2, reason: { kind: 'aborted' } } } } };
      processed();
      await new Promise(() => {});
    };
    void h.pumpMux();
    await Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(new Error('event processing timeout')), 2000))]);
    assert.equal(h.calls.sent.length, 1);
    assert.equal(h.calls.sent[0].text, '⏹️ 已停止');
  } finally { await h.close(); }
});
