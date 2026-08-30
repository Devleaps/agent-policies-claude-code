'use strict';

const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { startFixtureServer } = require('./fixture-server');

const CLIENT_PATH = path.join(__dirname, '..', '..', 'scripts', 'client.js');

let fixture;
let scratchDir;

before(async () => {
  fixture = await startFixtureServer();
});

after(() => {
  fixture.server.close();
});

beforeEach(() => {
  scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-policies-client-test-'));
  fs.writeFileSync(
    path.join(scratchDir, 'config.json'),
    JSON.stringify({ server_url: fixture.url, bundles: ['universal'] }),
  );
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

function runClient(hookPayload) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [CLIENT_PATH],
      { env: { ...process.env, AGENT_POLICIES_HOME: scratchDir } },
      (err, stdout, stderr) => {
        if (err && err.code !== 0) return reject(new Error(`client.js exited ${err.code}: ${stderr}`));
        resolve({ stdout, stderr });
      },
    );
    child.stdin.write(JSON.stringify(hookPayload));
    child.stdin.end();
  });
}

test('allows a benign bash command via the real local daemon', async () => {
  const { stdout } = await runClient({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'cat file.txt' },
  });
  const output = JSON.parse(stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'allow');
});

test('denies a command the fixture policy explicitly rejects', async () => {
  const { stdout } = await runClient({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'rm file.txt' },
  });
  const output = JSON.parse(stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /trash/);
});

test('an unparseable command is denied, not silently passed through', async () => {
  const { stdout } = await runClient({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: "cat > /tmp/test.py << 'EOF'" },
  });
  const output = JSON.parse(stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /parsed/i);
});

test('allows an allowlisted WebFetch host', async () => {
  const { stdout } = await runClient({
    hook_event_name: 'PreToolUse',
    tool_name: 'WebFetch',
    tool_input: { url: 'https://github.com/some/repo' },
  });
  const output = JSON.parse(stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'allow');
});

test('an unrelated tool with no policy relevance passes through untouched', async () => {
  const { stdout } = await runClient({
    hook_event_name: 'PreToolUse',
    tool_name: 'Read',
    tool_input: { file_path: '/some/file.txt' },
  });
  const output = JSON.parse(stdout);
  assert.deepEqual(output, { continue: true });
});

test('SessionStart warms the daemon and returns bare continue', async () => {
  const { stdout } = await runClient({ hook_event_name: 'SessionStart' });
  const output = JSON.parse(stdout);
  assert.deepEqual(output, { continue: true });

  const statePath = path.join(scratchDir, 'opa.state.json');
  assert.equal(fs.existsSync(statePath), true, 'daemon should have been spawned by SessionStart');
});

test('SessionStart with an unknown bundle name does not fail, and spawns no daemon', async () => {
  fs.writeFileSync(
    path.join(scratchDir, 'config.json'),
    JSON.stringify({ server_url: fixture.url, bundles: ['not-a-real-bundle'] }),
  );

  const { stdout } = await runClient({ hook_event_name: 'SessionStart' });
  const output = JSON.parse(stdout);
  assert.deepEqual(output, { continue: true });

  const statePath = path.join(scratchDir, 'opa.state.json');
  assert.equal(fs.existsSync(statePath), false);
});

test('a Write with a comment that merely restates the code produces the comment_overlap guidance', async () => {
  const { stdout } = await runClient({
    hook_event_name: 'PostToolUse',
    tool_name: 'Write',
    tool_input: { file_path: 'src/app.py' },
    tool_response: {
      structuredPatch: [
        {
          oldStart: 1,
          oldLines: 0,
          newStart: 1,
          newLines: 1,
          lines: ['+get_user(user_id)  # get user'],
        },
      ],
    },
  });
  const output = JSON.parse(stdout);
  assert.match(output.hookSpecificOutput.additionalContext, /Ensure comments add value/);
});

test('an Edit mentioning "deprecated" produces the legacy_code guidance', async () => {
  const { stdout } = await runClient({
    hook_event_name: 'PostToolUse',
    tool_name: 'Edit',
    tool_input: { file_path: 'src/app.py' },
    tool_response: {
      structuredPatch: [
        {
          oldStart: 1,
          oldLines: 0,
          newStart: 1,
          newLines: 1,
          lines: ['+# this code path is deprecated'],
        },
      ],
    },
  });
  const output = JSON.parse(stdout);
  assert.match(output.hookSpecificOutput.additionalContext, /backwards compatibility actually a requirement/);
});

test('a Write with clean, non-restating comments produces no guidance', async () => {
  const { stdout } = await runClient({
    hook_event_name: 'PostToolUse',
    tool_name: 'Write',
    tool_input: { file_path: 'src/app.py' },
    tool_response: {
      structuredPatch: [
        {
          oldStart: 1,
          oldLines: 0,
          newStart: 1,
          newLines: 2,
          lines: ['+x = 1  # workaround for a vendor library bug, see issue 42', '+y = 2'],
        },
      ],
    },
  });
  const output = JSON.parse(stdout);
  assert.deepEqual(output, { continue: true });
});

test('an Edit on a non-.py file produces no file-edit guidance at all', async () => {
  const { stdout } = await runClient({
    hook_event_name: 'PostToolUse',
    tool_name: 'Edit',
    tool_input: { file_path: 'src/app.js' },
    tool_response: {
      structuredPatch: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ['+# deprecated'] }],
    },
  });
  const output = JSON.parse(stdout);
  assert.deepEqual(output, { continue: true });
});

test('a PreToolUse Edit event (no tool_response yet) passes through untouched', async () => {
  const { stdout } = await runClient({
    hook_event_name: 'PreToolUse',
    tool_name: 'Edit',
    tool_input: { file_path: 'src/app.py' },
  });
  const output = JSON.parse(stdout);
  assert.deepEqual(output, { continue: true });
});

test('a session flag set by one decision persists to disk and is read by the next invocation', async () => {
  const sessionId = 'flags-test-session';

  const pushBeforeCommit = await runClient({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'git push' },
    session_id: sessionId,
  });
  assert.equal(JSON.parse(pushBeforeCommit.stdout).hookSpecificOutput.permissionDecision, 'deny');

  const commit = await runClient({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'git commit' },
    session_id: sessionId,
  });
  assert.equal(JSON.parse(commit.stdout).hookSpecificOutput.permissionDecision, 'allow');

  // A *separate* client.js process (this is a fresh runClient call, its own
  // process) must see the flag the previous invocation persisted to disk -
  // the fixture's deny rule only fires when session_flags.committed is
  // unset, so a bare {continue: true} here proves the flag suppressed it.
  const pushAfterCommit = await runClient({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'git push' },
    session_id: sessionId,
  });
  assert.deepEqual(JSON.parse(pushAfterCommit.stdout), { continue: true });

  const stateFile = path.join(scratchDir, 'state', `${sessionId}.json`);
  assert.equal(fs.existsSync(stateFile), true);
});

test('session flags are isolated per session_id', async () => {
  await runClient({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'git commit' },
    session_id: 'session-a',
  });

  const otherSessionPush = await runClient({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'git push' },
    session_id: 'session-b',
  });
  assert.equal(JSON.parse(otherSessionPush.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('a second invocation reuses the already-running daemon', async () => {
  await runClient({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'cat file.txt' },
  });
  const statePath = path.join(scratchDir, 'opa.state.json');
  const firstState = JSON.parse(fs.readFileSync(statePath, 'utf8'));

  await runClient({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'cat other.txt' },
  });
  const secondState = JSON.parse(fs.readFileSync(statePath, 'utf8'));

  assert.equal(secondState.pid, firstState.pid);
});

test('a daemon that died since the last invocation is detected and replaced, not silently treated as reusable', async () => {
  await runClient({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'cat file.txt' },
  });
  const statePath = path.join(scratchDir, 'opa.state.json');
  const firstState = JSON.parse(fs.readFileSync(statePath, 'utf8'));

  // Simulate the daemon crashing/being killed externally while the state
  // file still records it as the last-known-good daemon - ensureDaemon no
  // longer probes this proactively (see its docstring), so the only way
  // this surfaces is the real query itself failing.
  process.kill(firstState.pid, 'SIGKILL');
  await new Promise((resolve) => setTimeout(resolve, 100));

  const { stdout } = await runClient({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'cat other.txt' },
  });
  const decision = JSON.parse(stdout).hookSpecificOutput.permissionDecision;
  assert.equal(decision, 'allow', 'the retried query against a freshly respawned daemon must still get a real answer');

  const secondState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.notEqual(secondState.pid, firstState.pid, 'a new daemon process must have been spawned');
});

test('an unknown bundle name in config falls back to default behavior without spawning a daemon', async () => {
  fs.writeFileSync(
    path.join(scratchDir, 'config.json'),
    JSON.stringify({ server_url: fixture.url, bundles: ['not-a-real-bundle'], default_policy_behavior: 'ask' }),
  );

  const { stdout } = await runClient({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'cat file.txt' },
  });
  const output = JSON.parse(stdout);
  // Matches the existing daemon-unreachable fallback exactly (client.js
  // passes an empty results array to mapToPreToolUseOutput either way,
  // which short-circuits to a bare {continue: true} regardless of
  // default_policy_behavior - see decide.js).
  assert.deepEqual(output, { continue: true });

  const statePath = path.join(scratchDir, 'opa.state.json');
  assert.equal(fs.existsSync(statePath), false, 'no daemon should have been spawned for an unknown bundle name');
});
