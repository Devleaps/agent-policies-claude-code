'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

test('node:test runner is wired up', () => {
  assert.equal(1 + 1, 2);
});
