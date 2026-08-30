'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { commentedCode } = require('../../src/measurements/commentedCode');

function patchOf(contentLines) {
  return { structured_patch: [{ lines: contentLines.map((content) => ({ operation: 'added', content })) }] };
}

test('two consecutive indented comment lines count as a run of 2', () => {
  const input = patchOf(['    # old_code()', '    # more_old_code()', 'def f(): pass']);
  assert.equal(commentedCode(input).max_run, 2);
});

test('a single indented comment line does not count as a run', () => {
  const input = patchOf(['    # just one comment', 'def f(): pass']);
  assert.equal(commentedCode(input).max_run, 1);
});

test('a run resets when interrupted by a non-matching line', () => {
  const input = patchOf(['    # a', 'code()', '    # b', '    # c']);
  assert.equal(commentedCode(input).max_run, 2);
});

test('comment content indented 2+ spaces after # also counts', () => {
  const input = patchOf(['#  old_code()', '#  more_old_code()']);
  assert.equal(commentedCode(input).max_run, 2);
});

test('a single-space-indented comment content does not match the commented-indented-code pattern', () => {
  const input = patchOf(['# a normal top-level comment']);
  assert.equal(commentedCode(input).max_run, 0);
});

test('no matching lines returns max_run 0', () => {
  const input = patchOf(['def f():', '    return 1']);
  assert.equal(commentedCode(input).max_run, 0);
});

test('a run does not span across separate patch hunks', () => {
  const input = {
    structured_patch: [
      { lines: [{ operation: 'added', content: '    # a' }] },
      { lines: [{ operation: 'added', content: '    # b' }] },
    ],
  };
  assert.equal(commentedCode(input).max_run, 1);
});
