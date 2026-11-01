// Offline schedule checks: no token, bridge or QQ connection required.
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'tools', 'ai-night-schedule.ps1');
function paused(at) {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
    encoding: 'utf8', env: { ...process.env, AI_SCHED_NOW: at, AI_SCHED_DRY: '1' }, timeout: 30000,
  });
  const value = /desiredPaused=(True|False)/.exec(out)?.[1];
  assert.ok(value, `missing dry-run decision: ${JSON.stringify(out)}`);
  return value === 'True';
}
test('ordinary Monday through Thursday are paused', () => {
  assert.equal(paused('2026-11-02 12:00'), true);
  assert.equal(paused('2026-11-05 21:59'), true);
});
test('Friday is active only from 16:00 through 21:59', () => {
  assert.equal(paused('2026-11-06 15:59'), true);
  assert.equal(paused('2026-11-06 16:00'), false);
  assert.equal(paused('2026-11-06 21:59'), false);
  assert.equal(paused('2026-11-06 22:00'), true);
});
test('weekends and listed holidays are active only from 10:00 through 21:59', () => {
  for (const day of ['2026-11-07', '2026-11-08', '2026-10-01']) {
    assert.equal(paused(`${day} 09:59`), true);
    assert.equal(paused(`${day} 10:00`), false);
    assert.equal(paused(`${day} 21:59`), false);
    assert.equal(paused(`${day} 22:00`), true);
  }
});
