import test from 'node:test';
import assert from 'node:assert/strict';
import { samePatchContent } from './build-agent-preset-patches.mjs';

test('preset drift checks accept CRLF only when content matches', () => {
  assert.equal(samePatchContent('a\r\nb\r\n', 'a\nb\n'), true);
  assert.equal(samePatchContent('a\r\nc\r\n', 'a\nb\n'), false);
  assert.equal(samePatchContent(null, 'a\n'), false);
});
