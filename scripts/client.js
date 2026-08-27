#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const { parseCommand, ParseError } = require('../src/parser');
const { ensureDaemon, socketPathFor } = require('../src/daemon');
const { queryWithMultiPass } = require('../src/twopass');
const { mapToPreToolUseOutput, mapToPostToolUseOutput } = require('../src/decide');
const { buildResolvedPaths } = require('../src/paths');

// ── Config ────────────────────────────────────────────────────────────────────

// AGENT_POLICIES_HOME overrides ~/.agent-policies for the config file, the
// daemon's socket/state/lock, and its opa-config.yaml - used by the test
// suite to run a real client.js + real opa daemon without touching a
// developer's actual daemon state.
const CONFIG_DIR = process.env.AGENT_POLICIES_HOME || path.join(os.homedir(), '.agent-policies');

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

  return null;
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

  const socketPath = socketPathFor(CONFIG_DIR);
  const allResults = [];
  for (const doc of inputDocs) {
    const decisions = await queryWithMultiPass(socketPath, bundles, doc);
    allResults.push(...decisions.map((d) => ({ kind: 'decision', ...d })));
  }

  const output =
    hookEventName === 'PreToolUse'
      ? mapToPreToolUseOutput(allResults, defaultPolicyBehavior)
      : mapToPostToolUseOutput(allResults);

  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

main();
