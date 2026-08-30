'use strict';

const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ensureDaemon, socketPathFor } = require('../../src/daemon');
const { queryWithMultiPass, UnknownRequireKindError, DaemonUnreachableError } = require('../../src/twopass');
const { startFixtureServer } = require('./fixture-server');

let fixture;
let scratchDir;
let socketPath;

before(async () => {
  fixture = await startFixtureServer();
});

after(() => {
  fixture.server.close();
});

beforeEach(async () => {
  scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-policies-twopass-test-'));
  const ready = await ensureDaemon(fixture.url, ['measurable'], scratchDir);
  assert.equal(ready, true, 'daemon must be healthy before each test');
  socketPath = socketPathFor(scratchDir);
});

afterEach(() => {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(scratchDir, 'opa.state.json'), 'utf8'));
    if (state.pid) process.kill(state.pid, 'SIGKILL');
  } catch {
    // no state file or already dead
  }
  fs.rmSync(scratchDir, { recursive: true, force: true });
});

// A fake resolver registry standing in for the real PyPI network call -
// tests control exactly what "measurement" comes back without touching
// the live internet or the disk cache.
function fakeResolvers(ages) {
  return {
    pypi_metadata: {
      keyedBy: 'package',
      resolve: async (entry) => {
        const ageDays = ages[entry.package];
        if (ageDays === undefined) return null;
        return { name: entry.package, age_days: ageDays, first_version: '1.0.0' };
      },
    },
  };
}

test('a command needing no measurement resolves in a single pass, and guidances are merged in', async () => {
  const results = await queryWithMultiPass(socketPath, ['measurable'], { command: 'plain-allow' });
  assert.deepEqual(results, [
    { kind: 'decision', action: 'allow' },
    { kind: 'guidance', content: 'a plain guidance with no measurement needed' },
  ]);
});

test('a guidance gated on a resolved unkeyed measurement fires using the same resolved value a decision used', async () => {
  const resolvers = {
    fake_measurement: { resolve: async () => ({ flagged: true }) },
  };
  const results = await queryWithMultiPass(
    socketPath,
    ['measurable'],
    { command: 'measured-guidance' },
    resolvers,
  );
  assert.deepEqual(results, [
    { kind: 'decision', action: 'allow' },
    { kind: 'guidance', content: 'guidance gated on a resolved unkeyed measurement' },
  ]);
});

test('a guidance gated on a resolved unkeyed measurement does not fire when the measurement says not flagged', async () => {
  const resolvers = {
    fake_measurement: { resolve: async () => ({ flagged: false }) },
  };
  const results = await queryWithMultiPass(
    socketPath,
    ['measurable'],
    { command: 'measured-guidance' },
    resolvers,
  );
  assert.deepEqual(results, [{ kind: 'decision', action: 'allow' }]);
});

test('an incomplete result is resolved and the second pass returns the final decision', async () => {
  const results = await queryWithMultiPass(
    socketPath,
    ['measurable'],
    { command: 'install-package', package: 'oldpkg' },
    fakeResolvers({ oldpkg: 2000 }),
  );
  assert.deepEqual(results, [{ kind: 'decision', action: 'allow' }]);
});

test('a resolved lookup that finds nothing produces the not-found deny, not incomplete again', async () => {
  const results = await queryWithMultiPass(
    socketPath,
    ['measurable'],
    { command: 'install-package', package: 'ghostpkg' },
    fakeResolvers({}), // resolver returns null for anything not listed
  );
  assert.deepEqual(results, [{ kind: 'decision', action: 'deny', reason: 'not found' }]);
});

test('two require entries of the same kind with different parameters are both resolved', async () => {
  const results = await queryWithMultiPass(
    socketPath,
    ['measurable'],
    { command: 'install-two-packages' },
    fakeResolvers({ alpha: 1000, beta: 1000 }),
  );
  assert.deepEqual(results, [{ kind: 'decision', action: 'allow' }]);
});

test('an unknown require kind falls back to no decisions rather than looping or throwing', async () => {
  const results = await queryWithMultiPass(socketPath, ['measurable'], { command: 'unknown-kind' });
  assert.deepEqual(results, []);
});

test('a policy that is still incomplete after being given what it asked for does not loop forever', async () => {
  const results = await queryWithMultiPass(
    socketPath,
    ['measurable'],
    { command: 'always-incomplete' },
    fakeResolvers({ whatever: 1000 }),
  );
  // Exactly 2 queries happened (MAX_PASSES), and the still-incomplete result
  // is dropped rather than surfaced.
  assert.deepEqual(results, []);
});

test('a missing/unreachable daemon socket throws DaemonUnreachableError rather than returning empty results', async () => {
  const deadSocketPath = path.join(scratchDir, 'no-daemon-here.sock');
  await assert.rejects(
    () => queryWithMultiPass(deadSocketPath, ['measurable'], { command: 'plain-allow' }),
    DaemonUnreachableError,
  );
});

test('resolveRequireEntries throws UnknownRequireKindError for an unregistered kind', async () => {
  const { resolveRequireEntries } = require('../../src/twopass');
  await assert.rejects(
    () => resolveRequireEntries([{ action: 'incomplete', require: [{ kind: 'nonexistent' }] }], {}, {}),
    UnknownRequireKindError,
  );
});

test('resolveRequireEntries merges unkeyed (measurement) kinds as flat values under measurements', async () => {
  const { resolveRequireEntries } = require('../../src/twopass');
  const fakeInput = { file_path: 'src/app.py' };
  const resolvers = {
    comment_ratio: { resolve: async (_entry, input) => ({ ratio: input.file_path.length }) },
  };
  const merged = await resolveRequireEntries(
    [{ action: 'incomplete', require: [{ kind: 'comment_ratio' }] }],
    fakeInput,
    resolvers,
  );
  assert.deepEqual(merged, { measurements: { comment_ratio: { ratio: 'src/app.py'.length } } });
});

test('resolveRequireEntries preserves a null unkeyed measurement result (measured, nothing to report)', async () => {
  const { resolveRequireEntries } = require('../../src/twopass');
  const resolvers = {
    comment_overlap: { resolve: async () => null },
  };
  const merged = await resolveRequireEntries(
    [{ action: 'incomplete', require: [{ kind: 'comment_overlap' }] }],
    {},
    resolvers,
  );
  assert.deepEqual(merged, { measurements: { comment_overlap: null } });
});

test('resolveRequireEntries resolves multiple unkeyed kinds requested together', async () => {
  const { resolveRequireEntries } = require('../../src/twopass');
  const resolvers = {
    comment_ratio: { resolve: async () => ({ ratio: 0.5 }) },
    legacy_code: { resolve: async () => ({ matched: true }) },
  };
  const merged = await resolveRequireEntries(
    [
      {
        action: 'incomplete',
        require: [{ kind: 'comment_ratio' }, { kind: 'legacy_code' }],
      },
    ],
    {},
    resolvers,
  );
  assert.deepEqual(merged, {
    measurements: { comment_ratio: { ratio: 0.5 }, legacy_code: { matched: true } },
  });
});
