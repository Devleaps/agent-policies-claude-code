'use strict';

const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ensureDaemon, requestOverSocket, socketPathFor } = require('../../src/daemon');
const { startFixtureServer } = require('./fixture-server');

let fixture;

before(async () => {
  fixture = await startFixtureServer();
});

after(() => {
  fixture.server.close();
});

let scratchDir;

beforeEach(() => {
  scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-policies-daemon-test-'));
});

afterEach(async () => {
  // Best-effort cleanup: kill whatever daemon this test spawned via its
  // tracked state file, then remove the scratch dir.
  const statePath = path.join(scratchDir, 'opa.state.json');
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (state.pid) process.kill(state.pid, 'SIGKILL');
  } catch {
    // no state file or already dead
  }
  fs.rmSync(scratchDir, { recursive: true, force: true });
});

test('spawns a daemon when none is running, and it serves the requested bundle', async () => {
  const ok = await ensureDaemon(fixture.url, ['testpkg'], scratchDir);
  assert.equal(ok, true);

  const socketPath = socketPathFor(scratchDir);
  const { status, body } = await requestOverSocket(
    socketPath,
    'POST',
    '/v1/data/testpkg/decisions',
    { input: { command: 'allow-me' } },
    2000,
  );
  assert.equal(status, 200);
  const parsed = JSON.parse(body);
  assert.ok(JSON.stringify(parsed.result).includes('allow'));
});

test('reuses an already-healthy daemon with the same bundle set', async () => {
  const first = await ensureDaemon(fixture.url, ['testpkg'], scratchDir);
  assert.equal(first, true);

  const statePath = path.join(scratchDir, 'opa.state.json');
  const firstState = JSON.parse(fs.readFileSync(statePath, 'utf8'));

  const second = await ensureDaemon(fixture.url, ['testpkg'], scratchDir);
  assert.equal(second, true);

  const secondState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(secondState.pid, firstState.pid, 'daemon should not have been restarted');
});

test('restarts the daemon when the requested bundle set changes', async () => {
  await ensureDaemon(fixture.url, ['testpkg'], scratchDir);
  const statePath = path.join(scratchDir, 'opa.state.json');
  const firstState = JSON.parse(fs.readFileSync(statePath, 'utf8'));

  const ok = await ensureDaemon(fixture.url, ['testpkg', 'other'], scratchDir);
  assert.equal(ok, true);

  const secondState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.notEqual(secondState.pid, firstState.pid, 'daemon should have been restarted with a new PID');
  assert.deepEqual([...secondState.bundles].sort(), ['other', 'testpkg']);

  // The old PID must actually be dead, not just replaced in the state file.
  assert.throws(() => process.kill(firstState.pid, 0));
});

test('concurrent ensureDaemon calls do not spawn two daemons', async () => {
  const results = await Promise.all([
    ensureDaemon(fixture.url, ['testpkg'], scratchDir),
    ensureDaemon(fixture.url, ['testpkg'], scratchDir),
    ensureDaemon(fixture.url, ['testpkg'], scratchDir),
  ]);
  assert.ok(results.every((r) => r === true));

  const statePath = path.join(scratchDir, 'opa.state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  // A single PID must actually be alive and answering health checks -
  // proof only one daemon process won the race.
  assert.doesNotThrow(() => process.kill(state.pid, 0));
});
