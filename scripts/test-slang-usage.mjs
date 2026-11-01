import test from 'node:test';
import assert from 'node:assert/strict';
import { createSlangUsage } from '../src/slang-usage.js';

test('separates accepted extraction and research calls, and preserves unknown usage', () => {
  let saved;
  const ledger = createSlangUsage({ read: () => null, write: (data) => { saved = structuredClone(data); } });
  ledger.accepted('extraction');
  ledger.completed('extraction', { input: 12, output: 3 });
  ledger.accepted('research');
  ledger.completed('research', null);
  assert.deepEqual(ledger.summary().extraction, { calls: 1, measured: 1, unknown: 0, input: 12, output: 3, pending: 0 });
  assert.equal(ledger.summary().research.unknown, 1);
  const restored = createSlangUsage({ read: () => saved, write: () => {} });
  assert.equal(restored.summary().extraction.input, 12);
  restored.reset();
  restored.completed('extraction', { input: 1, output: 1 });
  assert.equal(restored.summary().extraction.calls, 0);
});

test('corrupt data remains unavailable and is not overwritten', () => {
  let writes = 0;
  const ledger = createSlangUsage({ read: () => { throw new Error('corrupt'); }, write: () => { writes++; } });
  ledger.accepted('research');
  assert.deepEqual(ledger.summary(), { available: false });
  assert.equal(writes, 0);
});
