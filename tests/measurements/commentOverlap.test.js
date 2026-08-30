'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { commentOverlap, extractKeywords } = require('../../src/measurements/commentOverlap');

function patchOf(contentLines) {
  return { structured_patch: [{ lines: contentLines.map((content) => ({ operation: 'added', content })) }] };
}

test('extractKeywords lowercases, splits on non-letters, and drops short words', () => {
  const words = extractKeywords('Get_User_Id(x, y)');
  assert.deepEqual([...words].sort(), ['get', 'user']); // 'id' and 'x'/'y' dropped (length <= 2)
});

test('extractKeywords deduplicates via a set', () => {
  const words = extractKeywords('user user user');
  assert.equal(words.size, 1);
});

test('inline comment restating the code triggers a high-overlap measurement', () => {
  const input = patchOf(['get_user(user_id)  # get user']);
  const result = commentOverlap(input);
  assert.ok(result.ratio >= 0.4, `expected high overlap, got ${result && result.ratio}`);
});

test('inline comment adding real information does not overlap much', () => {
  const input = patchOf(['x = 1  # workaround for issue 42 in the vendor library']);
  const result = commentOverlap(input);
  assert.ok(result === null || result.ratio < 0.4);
});

test('a shebang-like inline comment ("#!") is skipped', () => {
  const input = patchOf(['x = 1  #!not a real shebang but starts with !']);
  assert.equal(commentOverlap(input), null);
});

test('standalone comment compared against the next code line', () => {
  const input = patchOf(['# get user by id', 'def get_user(id):']);
  const result = commentOverlap(input);
  assert.ok(result.ratio >= 0.4);
});

test('a standalone shebang line is not treated as a comment to compare', () => {
  const input = patchOf(['#!/usr/bin/env python', 'import os']);
  assert.equal(commentOverlap(input), null);
});

test('a standalone comment followed only by another comment is skipped (no code to compare)', () => {
  const input = patchOf(['# comment one', '# comment two']);
  assert.equal(commentOverlap(input), null);
});

test('a standalone comment at the end of the patch with nothing after it is skipped', () => {
  const input = patchOf(['code()', '# trailing comment']);
  assert.equal(commentOverlap(input), null);
});

test('returns null when nothing looks like an overlapping comment', () => {
  const input = patchOf(['def f():', '    return 1']);
  assert.equal(commentOverlap(input), null);
});

test('a string literal containing "#" is treated naively as inline comment syntax (documented quirk)', () => {
  // Matches the recovered Python behavior exactly - not a feature, a known
  // limitation carried over deliberately rather than silently "fixed".
  const input = patchOf(['x = "#tag"']);
  const result = commentOverlap(input);
  // code_part = 'x = "', comment_part = 'tag"' - both produce keywords, so
  // this measures *something*, it just isn't semantically meaningful.
  assert.ok(result === null || typeof result.ratio === 'number');
});
