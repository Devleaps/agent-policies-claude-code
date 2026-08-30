'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { legacyCode } = require('../../src/measurements/legacyCode');

function patchOf(contentLines) {
  return { structured_patch: [{ lines: contentLines.map((content) => ({ operation: 'added', content })) }] };
}

test('matches "legacy" as a whole word', () => {
  assert.equal(legacyCode(patchOf(['# legacy support below'])).matched, true);
});

test('does not match "legacy" as a substring of another word', () => {
  assert.equal(legacyCode(patchOf(['def legacynames(): pass'])).matched, false);
});

test('matches "deprecated"', () => {
  assert.equal(legacyCode(patchOf(['# this function is deprecated'])).matched, true);
});

test('matches "backwards compatibility"', () => {
  assert.equal(legacyCode(patchOf(['kept for backwards compatibility'])).matched, true);
});

test('matches "backward compatibility" (singular)', () => {
  assert.equal(legacyCode(patchOf(['kept for backward compatibility'])).matched, true);
});

test('is case-insensitive', () => {
  assert.equal(legacyCode(patchOf(['LEGACY reasons'])).matched, true);
});

test('returns false when nothing matches', () => {
  assert.equal(legacyCode(patchOf(['def f(): return 1'])).matched, false);
});
