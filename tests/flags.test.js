'use strict';

// 1:1 port of the deleted tests/session/test_flags.py (recovered via
// `git show 40f77ec~1:tests/session/test_flags.py` in agent-policies-server),
// against src/flags.js's disk-backed implementation instead of the
// deleted server's in-memory-per-process dict. Each test uses its own
// scratch stateDir so tests never interfere with each other or a
// developer's real ~/.agent-policies/state.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  cleanupExpired,
  decrementInvocations,
  getAllFlags,
  getFlag,
  clearFlags,
  applyFlagSpec,
  sweepStaleState,
} = require('../src/flags');

let stateDir;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-policies-flags-test-'));
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

test('set and get a flag with a specific value', () => {
  const sessionId = 'test-session-1';
  applyFlagSpec(sessionId, { name: 'test_flag', value: true }, { stateDir });
  assert.equal(getFlag(sessionId, 'test_flag', undefined, { stateDir }), true);
  assert.equal(getFlag(sessionId, 'test_flag', true, { stateDir }), true);
  assert.equal(getFlag(sessionId, 'test_flag', false, { stateDir }), false);
});

test('set and get a valueless (presence-only) flag', () => {
  const sessionId = 'test-session-2';
  applyFlagSpec(sessionId, { name: 'presence_flag' }, { stateDir });
  assert.equal(getFlag(sessionId, 'presence_flag', undefined, { stateDir }), true);
  assert.equal(getFlag(sessionId, 'presence_flag', true, { stateDir }), true);
});

test('getting a nonexistent flag returns false', () => {
  const sessionId = 'test-session-3';
  assert.equal(getFlag(sessionId, 'nonexistent', undefined, { stateDir }), false);
  assert.equal(getFlag(sessionId, 'nonexistent', 'any_value', { stateDir }), false);
});

test('setting a flag twice overwrites the previous value', () => {
  const sessionId = 'test-session-4';
  applyFlagSpec(sessionId, { name: 'counter', value: 1 }, { stateDir });
  assert.equal(getFlag(sessionId, 'counter', 1, { stateDir }), true);

  applyFlagSpec(sessionId, { name: 'counter', value: 2 }, { stateDir });
  assert.equal(getFlag(sessionId, 'counter', 1, { stateDir }), false);
  assert.equal(getFlag(sessionId, 'counter', 2, { stateDir }), true);
});

test('invocation-based expiration counts down and expires at zero', () => {
  const sessionId = 'test-session-5';
  applyFlagSpec(
    sessionId,
    { name: 'invocation_flag', value: true, expires_after: 3, expires_unit: 'invocations' },
    { stateDir },
  );

  assert.equal(getFlag(sessionId, 'invocation_flag', undefined, { stateDir }), true);

  decrementInvocations(sessionId, { stateDir });
  assert.equal(getFlag(sessionId, 'invocation_flag', undefined, { stateDir }), true); // 2 remaining

  decrementInvocations(sessionId, { stateDir });
  assert.equal(getFlag(sessionId, 'invocation_flag', undefined, { stateDir }), true); // 1 remaining

  decrementInvocations(sessionId, { stateDir });
  assert.equal(getFlag(sessionId, 'invocation_flag', undefined, { stateDir }), false); // 0 remaining
});

test('time-based expiration', () => {
  const sessionId = 'test-session-6';
  let mockNow = 1000.0 * 1000; // Date.now() is ms; the deleted Python test used time.time() in seconds

  applyFlagSpec(
    sessionId,
    { name: 'time_flag', value: true, expires_after: 1, expires_unit: 'seconds' },
    { stateDir, now: () => mockNow },
  );

  assert.equal(getFlag(sessionId, 'time_flag', undefined, { stateDir, now: () => mockNow }), true);

  mockNow = 1001.1 * 1000; // advance 1.1s
  assert.equal(getFlag(sessionId, 'time_flag', undefined, { stateDir, now: () => mockNow }), false);
});

test('expires_after: 0 expires immediately', () => {
  const sessionId = 'test-session-7';
  applyFlagSpec(sessionId, { name: 'immediate', expires_after: 0, expires_unit: 'invocations' }, { stateDir });
  assert.equal(getFlag(sessionId, 'immediate', undefined, { stateDir }), false);
});

test('cleanupExpired removes expired flags but keeps active ones', () => {
  const sessionId = 'test-session-8';
  applyFlagSpec(sessionId, { name: 'expired', expires_after: 0, expires_unit: 'invocations' }, { stateDir });
  applyFlagSpec(sessionId, { name: 'active', value: true }, { stateDir });

  cleanupExpired(sessionId, { stateDir });

  const flags = getAllFlags(sessionId, { stateDir });
  assert.equal('expired' in flags, false);
  assert.equal('active' in flags, true);
  assert.equal(flags.active, true);
});

test('getAllFlags returns every active flag with its value', () => {
  const sessionId = 'test-session-9';
  applyFlagSpec(sessionId, { name: 'flag1', value: 'value1' }, { stateDir });
  applyFlagSpec(sessionId, { name: 'flag2', value: 42 }, { stateDir });
  applyFlagSpec(sessionId, { name: 'flag3' }, { stateDir });

  const flags = getAllFlags(sessionId, { stateDir });
  assert.equal(Object.keys(flags).length, 3);
  assert.equal(flags.flag1, 'value1');
  assert.equal(flags.flag2, 42);
  assert.equal(flags.flag3, true);
});

test('clearFlags removes every flag for a session', () => {
  const sessionId = 'test-session-10';
  applyFlagSpec(sessionId, { name: 'flag1', value: true }, { stateDir });
  applyFlagSpec(sessionId, { name: 'flag2', value: true }, { stateDir });

  clearFlags(sessionId, { stateDir });

  assert.equal(getFlag(sessionId, 'flag1', undefined, { stateDir }), false);
  assert.equal(getFlag(sessionId, 'flag2', undefined, { stateDir }), false);
  assert.deepEqual(getAllFlags(sessionId, { stateDir }), {});
});

test('flags in different sessions are isolated', () => {
  const session1 = 'session-1';
  const session2 = 'session-2';

  applyFlagSpec(session1, { name: 'flag', value: 'session1' }, { stateDir });
  applyFlagSpec(session2, { name: 'flag', value: 'session2' }, { stateDir });

  assert.equal(getFlag(session1, 'flag', 'session1', { stateDir }), true);
  assert.equal(getFlag(session1, 'flag', 'session2', { stateDir }), false);

  assert.equal(getFlag(session2, 'flag', 'session2', { stateDir }), true);
  assert.equal(getFlag(session2, 'flag', 'session1', { stateDir }), false);
});

test('a flag with no expiration persists indefinitely', () => {
  const sessionId = 'test-session-11';
  applyFlagSpec(sessionId, { name: 'persistent', value: true }, { stateDir });

  for (let i = 0; i < 100; i += 1) {
    decrementInvocations(sessionId, { stateDir });
  }

  assert.equal(getFlag(sessionId, 'persistent', undefined, { stateDir }), true);

  cleanupExpired(sessionId, { stateDir });
  assert.equal(getFlag(sessionId, 'persistent', undefined, { stateDir }), true);
});

// New coverage beyond the recovered Python spec, for behavior specific to
// this port (disk persistence, sweeping stale state files).

test('sweepStaleState deletes state files older than maxAgeMs', () => {
  applyFlagSpec('old-session', { name: 'flag', value: true }, { stateDir });
  applyFlagSpec('recent-session', { name: 'flag', value: true }, { stateDir });

  const oldFilePath = path.join(stateDir, 'old-session.json');
  const oldTime = Date.now() - 10 * 24 * 60 * 60 * 1000; // 10 days ago
  fs.utimesSync(oldFilePath, oldTime / 1000, oldTime / 1000);

  sweepStaleState({ stateDir, maxAgeMs: 7 * 24 * 60 * 60 * 1000 });

  assert.equal(fs.existsSync(oldFilePath), false);
  assert.equal(fs.existsSync(path.join(stateDir, 'recent-session.json')), true);
});

test('sweepStaleState against a nonexistent stateDir does not throw', () => {
  assert.doesNotThrow(() => sweepStaleState({ stateDir: path.join(stateDir, 'does-not-exist') }));
});

test('overwriting a flag resets its invocation counter', () => {
  const sessionId = 'test-session-reset';
  applyFlagSpec(
    sessionId,
    { name: 'counter_flag', expires_after: 2, expires_unit: 'invocations' },
    { stateDir },
  );
  decrementInvocations(sessionId, { stateDir }); // 1 remaining

  // Re-set the same flag - must reset the counter, not continue from 1.
  applyFlagSpec(
    sessionId,
    { name: 'counter_flag', expires_after: 2, expires_unit: 'invocations' },
    { stateDir },
  );
  decrementInvocations(sessionId, { stateDir }); // 1 remaining again, not 0
  assert.equal(getFlag(sessionId, 'counter_flag', undefined, { stateDir }), true);
});
