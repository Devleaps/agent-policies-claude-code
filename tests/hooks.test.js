'use strict';

// End-to-end test of this plugin's actual hooks.json - not a hand-written
// stand-in for what it does. Parses the real command string (including its
// ${CLAUDE_PLUGIN_ROOT} substitution, exactly as Claude Code's own hook
// runner would), spawns it with a real Claude hook payload on stdin, and
// asserts the JSON hook output - against a real agent-policies-adapter
// (installed as this repo's actual npm dependency) and a real opa daemon,
// not mocks.

const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const { startFixtureServer } = require('./fixture-server');

const PLUGIN_ROOT = path.join(__dirname, '..');
const HOOKS_CONFIG = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8'));

function commandFor(eventName) {
  const entry = HOOKS_CONFIG.hooks[eventName][0].hooks[0];
  return entry.command.replaceAll('${CLAUDE_PLUGIN_ROOT}', PLUGIN_ROOT);
}

let fixture;

before(async () => {
  fixture = await startFixtureServer();
});

after(() => {
  fixture.server.close();
});

let configDir;

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-policies-claude-code-test-'));
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({ server_url: fixture.url, bundles: ['universal'], default_policy_behavior: 'ask' }),
  );
});

afterEach(() => {
  try {
    const adapterState = JSON.parse(fs.readFileSync(path.join(configDir, 'adapter.state.json'), 'utf8'));
    if (adapterState.pid) process.kill(adapterState.pid, 'SIGKILL');
  } catch {
    // no state file or already dead
  }
  try {
    const opaState = JSON.parse(fs.readFileSync(path.join(configDir, 'opa.state.json'), 'utf8'));
    if (opaState.pid) process.kill(opaState.pid, 'SIGKILL');
  } catch {
    // no state file or already dead
  }
  fs.rmSync(configDir, { recursive: true, force: true });
});

function runHook(eventName, hookPayload) {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = commandFor(eventName).split(' ');
    const child = execFile(
      cmd,
      args,
      { env: { ...process.env, AGENT_POLICIES_HOME: configDir }, timeout: 20_000 },
      (err, stdout, stderr) => {
        if (err && err.code !== 0) return reject(new Error(`hook exited ${err.code}: ${stderr}`));
        resolve(stdout);
      },
    );
    child.stdin.write(JSON.stringify({ hook_event_name: eventName, ...hookPayload }));
    child.stdin.end();
  });
}

test('PreToolUse denies a real Bash command via the full plugin -> adapter -> opa pipeline', async () => {
  const stdout = await runHook('PreToolUse', {
    tool_name: 'Bash',
    tool_input: { command: 'rm file.txt' },
    session_id: 'plugin-e2e-test',
  });
  const output = JSON.parse(stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /rm is not allowed/);
});

test('PreToolUse allows a real Bash command matched by an explicit allow rule', async () => {
  const stdout = await runHook('PreToolUse', {
    tool_name: 'Bash',
    tool_input: { command: 'cat file.txt' },
    session_id: 'plugin-e2e-test',
  });
  const output = JSON.parse(stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'allow');
});

test('a tool with no matching policy falls back to configured default_policy_behavior', async () => {
  const stdout = await runHook('PreToolUse', {
    tool_name: 'Bash',
    tool_input: { command: 'ls -la' },
    session_id: 'plugin-e2e-test',
  });
  const output = JSON.parse(stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'ask');
});

test('SessionStart warms the adapter and passes through without a decision', async () => {
  const stdout = await runHook('SessionStart', {});
  const output = JSON.parse(stdout);
  assert.deepEqual(output, { continue: true });
});

test('a hook event this plugin does not register still passes through untouched', async () => {
  // hooks.json has no "Notification" entry of its own - every registered
  // hook invokes the identical command, so reuse PreToolUse's and rely on
  // the payload's own hook_event_name for dispatch, exactly as the real
  // shared script does regardless of which hooks.json entry invoked it.
  const [cmd, ...args] = commandFor('PreToolUse').split(' ');
  const stdout = await new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      { env: { ...process.env, AGENT_POLICIES_HOME: configDir }, timeout: 20_000 },
      (err, out, stderr) => {
        if (err && err.code !== 0) return reject(new Error(`hook exited ${err.code}: ${stderr}`));
        resolve(out);
      },
    );
    child.stdin.write(JSON.stringify({ hook_event_name: 'Notification' }));
    child.stdin.end();
  });
  const output = JSON.parse(stdout);
  assert.deepEqual(output, { continue: true });
});
