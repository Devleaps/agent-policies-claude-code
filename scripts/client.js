#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const { parseCommand, ParseError } = require('../src/parser');
const { ensureDaemon, socketPathFor, allBundlesKnown } = require('../src/daemon');
const { queryWithMultiPass } = require('../src/twopass');
const { mapToPreToolUseOutput, mapToPostToolUseOutput } = require('../src/decide');
const { buildResolvedPaths } = require('../src/paths');
const {
  cleanupExpired,
  decrementInvocations,
  getAllFlags,
  applyFlagSpec,
  sweepStaleState,
} = require('../src/flags');

// ── Config ────────────────────────────────────────────────────────────────────

// AGENT_POLICIES_HOME overrides ~/.agent-policies for the config file, the
// daemon's socket/state/lock, and its opa-config.yaml - used by the test
// suite to run a real client.js + real opa daemon without touching a
// developer's actual daemon state.
const CONFIG_DIR = process.env.AGENT_POLICIES_HOME || path.join(os.homedir(), '.agent-policies');
const STATE_DIR = path.join(CONFIG_DIR, 'state');

function loadConfig() {
  try {
    const raw = fs.readFileSync(path.join(CONFIG_DIR, 'config.json'), 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return {};
  }
}

// ── Stdin ─────────────────────────────────────────────────────────────────────

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (buf += chunk));
    process.stdin.on('end', () => resolve(buf.trim()));
  });
}

// ── Input document construction ──────────────────────────────────────────────

/**
 * Recursively flatten a ParsedCommand's pipes/chained/process_substitutions
 * into one Rego input document per command - a policy like "deny xargs" must
 * fire for `find . | xargs rm` even though xargs is a piped command, not the
 * top-level executable, so every command in the chain needs its own query.
 */
function flattenCommandsToInputs(parsed, sharedEventFields, workspaceRoot, cwd, home) {
  const resolvedPaths = buildResolvedPaths(parsed, workspaceRoot, cwd, home);
  const inputs = [
    {
      event: sharedEventFields,
      parsed: parsedCommandToRegoInput(parsed),
      resolved_paths: resolvedPaths,
    },
  ];

  for (const nested of [...parsed.pipes, ...parsed.chained, ...parsed.process_substitutions]) {
    inputs.push(...flattenCommandsToInputs(nested, sharedEventFields, workspaceRoot, cwd, home));
  }

  return inputs;
}

/**
 * Build the Rego input document(s) for one tool-use event. Returns null for
 * tools/events with no policy relevance, or an array of input documents to
 * query (more than one for piped/chained Bash commands).
 */
async function buildInputDocuments(payload, context) {
  const toolName = payload.tool_name;
  const toolInput = payload.tool_input || {};
  const { workspaceRoot, cwd, home, enabledBundles } = context;

  if (toolName === 'Bash') {
    const command = typeof toolInput.command === 'string' ? toolInput.command.trim() : '';
    if (!command) return null;

    let parsed;
    try {
      parsed = await parseCommand(command);
    } catch (err) {
      if (err instanceof ParseError) {
        // "Not understood by the parser = not allowed": an unparseable
        // command must DENY, not silently pass through.
        return { forcedDenyReason: `Command could not be parsed: ${err.message}` };
      }
      throw err;
    }

    const sharedEventFields = {
      tool_name: toolName,
      command,
      workspace_root: workspaceRoot,
      enabled_bundles: enabledBundles,
    };
    return flattenCommandsToInputs(parsed, sharedEventFields, workspaceRoot, cwd, home);
  }

  if (toolName === 'WebFetch') {
    const url = typeof toolInput.url === 'string' ? toolInput.url : null;
    if (!url) return null;
    let host = null;
    try {
      host = new URL(url).hostname;
    } catch {
      return null;
    }
    return [
      { event: { tool_name: toolName, parameters: { host }, enabled_bundles: enabledBundles } },
    ];
  }

  if (toolName === 'Edit' || toolName === 'Write') {
    // File-edit guidance needs the diff, which only exists once the edit
    // has actually happened - PreToolUse has no tool_response yet, so
    // there is nothing to build here on that hook (matches the old
    // server's scope: file-edit guidance only ever ran on PostToolUse).
    // MultiEdit/NotebookEdit are deliberately out of scope, same as the
    // deleted server never handled them either - see mapper dispatch logic
    // recovered from git history.
    const filePath = typeof toolInput.file_path === 'string' ? toolInput.file_path : null;
    const structuredPatch = payload.tool_response && payload.tool_response.structuredPatch;
    if (!filePath || !Array.isArray(structuredPatch)) return null;

    return [
      {
        file_path: filePath,
        structured_patch: structuredPatch.map((patch) => ({
          old_start: patch.oldStart,
          old_lines: patch.oldLines,
          new_start: patch.newStart,
          new_lines: patch.newLines,
          lines: parsePatchLines(patch.lines || []),
        })),
        event: { tool_name: toolName, enabled_bundles: enabledBundles },
      },
    ];
  }

  return null;
}

/**
 * Convert raw unified-diff strings ("+added", "-removed", " unchanged") into
 * {operation, content} pairs - the same shape rego_tests/universal's
 * file_edit_guidance policies and src/measurements/*.js resolvers expect.
 * An empty line has no prefix character to strip and becomes {operation:
 * "unchanged", content: ""}.
 */
function parsePatchLines(rawLines) {
  return rawLines.map((line) => {
    if (line.startsWith('+')) return { operation: 'added', content: line.slice(1) };
    if (line.startsWith('-')) return { operation: 'removed', content: line.slice(1) };
    if (line === '') return { operation: 'unchanged', content: '' };
    return { operation: 'unchanged', content: line.startsWith(' ') ? line.slice(1) : line };
  });
}

function parsedCommandToRegoInput(parsed) {
  return {
    executable: parsed.executable,
    subcommand: parsed.subcommand,
    arguments: parsed.arguments,
    flags: parsed.flags,
    options: parsed.options,
    redirects: parsed.redirects.map(([op, target]) => ({ op, path: target })),
    original: parsed.original,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const config = loadConfig();
  const serverUrl = config.server_url || 'https://agent-policies.devleaps.nl';
  const bundles = config.bundles || ['universal'];
  const defaultPolicyBehavior = config.default_policy_behavior || null;

  let raw;
  try {
    raw = await readStdin();
  } catch (e) {
    process.stderr.write('Error reading stdin\n');
    process.exit(2);
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`Invalid JSON in hook payload: ${e.message}\n`);
    process.exit(2);
  }

  const hookEventName = payload.hook_event_name;
  if (!hookEventName) {
    process.stderr.write('Missing hook_event_name in payload\n');
    process.exit(2);
  }

  if (hookEventName === 'SessionStart') {
    // No decision to make here - just warm the daemon (and its bundle
    // fetch) before the first real tool call needs it, so that call isn't
    // the one paying for a cold spawn. Never block or fail session start:
    // if the daemon can't come up (unknown bundle, daemon unreachable), log
    // and continue exactly as the Pre/PostToolUse paths already do.
    if (allBundlesKnown(bundles)) {
      const ready = await ensureDaemon(serverUrl, bundles, CONFIG_DIR);
      if (!ready) {
        process.stderr.write('SessionStart: local policy daemon did not become ready\n');
      }
    } else {
      process.stderr.write(`SessionStart: unknown bundle(s) in config: ${bundles.join(', ')}\n`);
    }
    // Disk-persisted flag state has no natural process-lifetime cleanup the
    // way the deleted server's in-memory dict did - sweep once per session
    // start instead, so state from long-past sessions doesn't accumulate
    // forever.
    sweepStaleState({ stateDir: STATE_DIR });
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  }

  if (hookEventName !== 'PreToolUse' && hookEventName !== 'PostToolUse') {
    // Only these two hooks carry policy-relevant tool-use events today.
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  }

  const context = {
    workspaceRoot: process.env.CLAUDE_PROJECT_DIR || null,
    cwd: payload.cwd || process.env.CLAUDE_PROJECT_DIR || null,
    home: os.homedir(),
    enabledBundles: bundles,
  };

  let inputDocs;
  try {
    inputDocs = await buildInputDocuments(payload, context);
  } catch (e) {
    process.stderr.write(`Failed to build policy input: ${e.message}\n`);
    process.exit(2);
  }

  if (inputDocs === null) {
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  }

  if (inputDocs.forcedDenyReason) {
    const results = [{ kind: 'decision', action: 'deny', reason: inputDocs.forcedDenyReason }];
    const output =
      hookEventName === 'PreToolUse'
        ? mapToPreToolUseOutput(results, defaultPolicyBehavior)
        : mapToPostToolUseOutput(results);
    process.stdout.write(JSON.stringify(output));
    process.exit(0);
  }

  if (!allBundlesKnown(bundles)) {
    // config.json names a bundle the server doesn't recognize - fail the
    // same way an unreachable daemon does, rather than passing an
    // unvalidated name through to the daemon's bundle-service resource URL.
    process.stderr.write(`Unknown bundle(s) in config: ${bundles.join(', ')}; falling back to default behavior\n`);
    const output =
      hookEventName === 'PreToolUse'
        ? mapToPreToolUseOutput([], defaultPolicyBehavior)
        : mapToPostToolUseOutput([]);
    process.stdout.write(JSON.stringify(output));
    process.exit(0);
  }

  const daemonReady = await ensureDaemon(serverUrl, bundles, CONFIG_DIR);
  if (!daemonReady) {
    process.stderr.write('Local policy daemon unavailable; falling back to default behavior\n');
    const output =
      hookEventName === 'PreToolUse'
        ? mapToPreToolUseOutput([], defaultPolicyBehavior)
        : mapToPostToolUseOutput([]);
    process.stdout.write(JSON.stringify(output));
    process.exit(0);
  }

  const sessionId = payload.session_id || null;
  let sessionFlags = {};
  if (sessionId) {
    // Per-event order matches the deleted server's executor exactly:
    // cleanup expired -> decrement invocation counters -> evaluate (reading
    // the post-decrement state) -> apply flags emitted by decisions (below).
    cleanupExpired(sessionId, { stateDir: STATE_DIR });
    decrementInvocations(sessionId, { stateDir: STATE_DIR });
    sessionFlags = getAllFlags(sessionId, { stateDir: STATE_DIR });
  }

  const socketPath = socketPathFor(CONFIG_DIR);
  const allResults = [];
  for (const doc of inputDocs) {
    const docWithFlags = { ...doc, session_flags: sessionFlags };
    // Already tagged {kind: 'decision'|'guidance', ...} by queryWithMultiPass.
    const results = await queryWithMultiPass(socketPath, bundles, docWithFlags);
    allResults.push(...results);
  }

  if (sessionId) {
    // Applied unconditionally per matching decision, including denies -
    // e.g. demo_flags/cooldown.rego depends on a deny decision setting a
    // flag - matching the deleted server's executor exactly.
    for (const result of allResults) {
      if (result.kind === 'decision' && Array.isArray(result.flags)) {
        for (const spec of result.flags) {
          applyFlagSpec(sessionId, spec, { stateDir: STATE_DIR });
        }
      }
    }
  }

  const output =
    hookEventName === 'PreToolUse'
      ? mapToPreToolUseOutput(allResults, defaultPolicyBehavior)
      : mapToPostToolUseOutput(allResults);

  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

main();
