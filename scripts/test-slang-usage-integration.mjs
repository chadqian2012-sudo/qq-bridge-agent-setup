import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { bridgeHarness } from './audit-bridge-harness.mjs';

for (const kind of ['extraction', 'research']) test(`a learner ${kind} turn is attributed without sending QQ messages`, async () => {
  const h = await bridgeHarness({ config: { slang: { enabled: true, extractMinMessages: 1, autoResearch: false } } });
  try {
    h.setMode('reserved2');
    h.slangWindows.set('group:456', [{ sender: 'member', text: 'hello', time: Date.now() }]);
    let trigger;
    const started = new Promise((resolve) => { trigger = resolve; });
    let delivered;
    const deliveredTurn = new Promise((resolve) => { delivered = resolve; });
    h.api.sessions.prompt = async ({ sessionId }) => {
      trigger(sessionId);
      await deliveredTurn; // exercise a turn that ends before prompt acknowledgement
      return { result: { ok: true, value: {} } };
    };
    h.api.events.mux = async function* () {
      const sessionId = await started;
      yield { payload: { type: 'session/event', sessionId, event: { type: 'turn/start', data: { turn: 1 } } } };
      yield { payload: { type: 'session/event', sessionId, event: { type: 'assistant/message', seq: 2, data: { turn: 1, step: 1, usage: { inputTokens: 123, cacheReadTokens: 20, outputTokens: 7 }, message: { content: [{ type: 'text', text: '[]' }] } } } } };
      yield { payload: { type: 'session/event', sessionId, event: { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } } };
      delivered();
      await new Promise(() => {});
    };
    void h.pumpMux();
    if (kind === 'extraction') await h.runSlangExtraction('group:456');
    else await h.runSlangResearch([{ id: 'fixture', content: 'sample', count: 2 }]);
    const result = h.slangUsage.summary();
    assert.equal(result[kind].calls, 1);
    assert.equal(result[kind].measured, 1);
    assert.equal(result[kind].input, 143);
    assert.equal(result[kind].output, 7);
    assert.equal(h.calls.sent.length, 0);
    const server = h.startConsoleServer();
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const summary = await new Promise((resolve, reject) => {
      http.get({ hostname: '127.0.0.1', port: server.address().port, path: '/api/tokens/summary', headers: { 'x-console-token': 'fixture-console-token' } }, (res) => {
        let data = ''; res.on('data', (chunk) => { data += chunk; }); res.on('end', () => resolve(JSON.parse(data)));
      }).on('error', reject);
    });
    assert.equal(summary.slangUsage[kind].input, 143);
    server.close();
  } finally { await h.close(); }
});
