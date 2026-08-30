'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { midCodeImport } = require('../../src/measurements/midCodeImport');

function patchOf(contentLines) {
  return { structured_patch: [{ lines: contentLines.map((content) => ({ operation: 'added', content })) }] };
}

test('a module-level import (no leading whitespace) does not match', () => {
  assert.equal(midCodeImport(patchOf(['import os'])).matched, false);
});

test('an indented "import x" matches', () => {
  assert.equal(midCodeImport(patchOf(['def f():', '    import os'])).matched, true);
});

test('an indented "from x import y" matches', () => {
  assert.equal(midCodeImport(patchOf(['def f():', '    from os import path'])).matched, true);
});

test('blank lines are skipped before checking', () => {
  assert.equal(midCodeImport(patchOf(['', '    import os'])).matched, true);
});

test('comment lines are skipped, not mistaken for imports', () => {
  assert.equal(midCodeImport(patchOf(['    # import os (just a comment)'])).matched, false);
});

test('returns false when there is no import at all', () => {
  assert.equal(midCodeImport(patchOf(['def f():', '    return 1'])).matched, false);
});
