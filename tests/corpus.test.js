'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseCorpus } = require('../src/corpus');

test('parses a single case with allow expectation', () => {
  const yaml = [
    '- name: "test_brew.py: brew info python"',
    '  bundles: [universal]',
    '  steps:',
    '    - bash: "brew info python"',
    '      expect: "allow"',
  ].join('\n');

  const cases = parseCorpus(yaml);
  assert.equal(cases.length, 1);
  assert.equal(cases[0].name, 'test_brew.py: brew info python');
  assert.deepEqual(cases[0].bundles, ['universal']);
  assert.deepEqual(cases[0].steps, [{ bash: 'brew info python', expect: 'allow' }]);
});

test('parses multiple bundles and multiple cases', () => {
  const yaml = [
    '- name: "case one"',
    '  bundles: [universal, python_uv]',
    '  steps:',
    '    - bash: "uv add requests"',
    '      expect: "allow"',
    '- name: "case two"',
    '  bundles: [universal]',
    '  steps:',
    '    - bash: "rm -rf /"',
    '      expect: "deny"',
  ].join('\n');

  const cases = parseCorpus(yaml);
  assert.equal(cases.length, 2);
  assert.deepEqual(cases[0].bundles, ['universal', 'python_uv']);
  assert.equal(cases[1].steps[0].bash, 'rm -rf /');
  assert.equal(cases[1].steps[0].expect, 'deny');
});

test('unescapes quotes and backslashes in commands', () => {
  const yaml = [
    '- name: "test"',
    '  bundles: [universal]',
    '  steps:',
    '    - bash: "git commit -m \\"msg\\""',
    '      expect: "allow"',
  ].join('\n');

  const cases = parseCorpus(yaml);
  assert.equal(cases[0].steps[0].bash, 'git commit -m "msg"');
});
