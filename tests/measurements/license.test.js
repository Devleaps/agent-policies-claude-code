'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { license } = require('../../src/measurements/license');

function patchOf(entries) {
  // entries: [[operation, content], ...]
  return { structured_patch: [{ lines: entries.map(([operation, content]) => ({ operation, content })) }] };
}

test('an added line mentioning "license" matches', () => {
  assert.equal(license(patchOf([['added', '## License']])).matched, true);
});

test('is case-insensitive', () => {
  assert.equal(license(patchOf([['added', 'LICENSE: MIT']])).matched, true);
});

test('an unchanged (context) line mentioning license does not match', () => {
  assert.equal(license(patchOf([['unchanged', '## License']])).matched, false);
});

test('a removed line mentioning license does not match', () => {
  assert.equal(license(patchOf([['removed', '## License']])).matched, false);
});

test('an added line with no mention of license does not match', () => {
  assert.equal(license(patchOf([['added', '## Installation']])).matched, false);
});
