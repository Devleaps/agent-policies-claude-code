'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizePath, buildResolvedPaths } = require('../src/paths');

const WORKSPACE = '/workspace';

test('relative path with no dotdot is returned unchanged', () => {
  assert.equal(normalizePath('file.txt', WORKSPACE, WORKSPACE, null), 'file.txt');
});

test('absolute path inside workspace resolves to workspace-relative', () => {
  assert.equal(normalizePath('/workspace/src/main.py', WORKSPACE, WORKSPACE, null), 'src/main.py');
});

test('absolute path outside workspace is returned unchanged (unsafe)', () => {
  assert.equal(normalizePath('/etc/passwd', WORKSPACE, WORKSPACE, null), '/etc/passwd');
});

test('absolute path that is a workspace-name prefix but not inside it stays unchanged', () => {
  assert.equal(normalizePath('/workspacefoo/bar', WORKSPACE, WORKSPACE, null), '/workspacefoo/bar');
});

test('dotdot path resolving inside workspace from a deep cwd resolves', () => {
  assert.equal(normalizePath('../../demo.txt', WORKSPACE, '/workspace/a/b', null), 'demo.txt');
});

test('dotdot path escaping the workspace stays unchanged (unsafe)', () => {
  assert.equal(normalizePath('../../../outside.txt', WORKSPACE, '/workspace/a/b', null), '../../../outside.txt');
});

test('tilde path with no home supplied stays unchanged (unsafe)', () => {
  assert.equal(normalizePath('~/README.md', WORKSPACE, WORKSPACE, null), '~/README.md');
});

test('tilde path resolves against client-supplied home when inside workspace', () => {
  assert.equal(normalizePath('~/README.md', WORKSPACE, WORKSPACE, '/workspace'), 'README.md');
});

test('tilde path against client home outside workspace stays unchanged', () => {
  assert.equal(normalizePath('~/.ssh/id_rsa', WORKSPACE, WORKSPACE, '/home/clientuser'), '~/.ssh/id_rsa');
});

test('other-user tilde path is never resolved', () => {
  assert.equal(normalizePath('~otheruser/file.txt', WORKSPACE, WORKSPACE, '/home/x'), '~otheruser/file.txt');
});

test('buildResolvedPaths only includes entries that actually changed', () => {
  const parsed = {
    arguments: ['relative.txt', '/workspace/src/main.py', '/etc/passwd'],
    redirects: [['>', '/workspace/out.log']],
    options: { '-C': '/workspace/subdir' },
  };
  const result = buildResolvedPaths(parsed, WORKSPACE, WORKSPACE, null);
  assert.deepEqual(result, {
    '/workspace/src/main.py': 'src/main.py',
    '/workspace/out.log': 'out.log',
    '/workspace/subdir': 'subdir',
  });
});
