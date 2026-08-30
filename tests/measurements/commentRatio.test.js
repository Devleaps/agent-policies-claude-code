'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { commentRatio } = require('../../src/measurements/commentRatio');

function patchOf(contentLines, operation = 'added') {
  return { structured_patch: [{ lines: contentLines.map((content) => ({ operation, content })) }] };
}

test('ratio counts comment lines as a fraction of all non-blank lines', () => {
  const input = patchOf(['# comment one', '# comment two', 'code()', 'code2()', 'code3()']);
  const result = commentRatio(input);
  assert.equal(result.ratio, 2 / 5);
});

test('blank lines are excluded from both counts', () => {
  const input = patchOf(['# comment', '', 'code()', '   ']);
  const result = commentRatio(input);
  assert.equal(result.ratio, 1 / 2);
});

test('a shebang line is not counted as a comment', () => {
  const input = patchOf(['#!/usr/bin/env python', 'code()']);
  const result = commentRatio(input);
  assert.equal(result.ratio, 0);
});

test('returns null when there is no code to compare against (all-comment patch)', () => {
  const input = patchOf(['# just a comment', '# another comment']);
  assert.equal(commentRatio(input), null);
});

test('returns null for an all-blank patch', () => {
  const input = patchOf(['', '   ', '']);
  assert.equal(commentRatio(input), null);
});

test('spans multiple patch hunks', () => {
  const input = {
    structured_patch: [
      { lines: [{ operation: 'added', content: '# c1' }, { operation: 'added', content: 'code()' }] },
      { lines: [{ operation: 'added', content: '# c2' }, { operation: 'added', content: 'code2()' }] },
    ],
  };
  const result = commentRatio(input);
  assert.equal(result.ratio, 2 / 4);
});
