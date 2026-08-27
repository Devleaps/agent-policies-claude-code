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
