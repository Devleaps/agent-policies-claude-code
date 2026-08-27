#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const { parseCommand, ParseError } = require('../src/parser');
const { ensureDaemon, requestOverSocket, socketPathFor } = require('../src/daemon');
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
 * into one Rego input document per command, matching RegoEvaluator.evaluate's
 * recursive evaluation (rego.py:120-132) - a policy like "deny xargs" must
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
 * tools/events with no policy relevance (mirrors the server's evaluate_*_rules
 * functions each returning early for non-matching tool_name), or an array of
 * input documents to query (more than one for piped/chained Bash commands).
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
        // command must DENY, not silently pass through. This is a
        // deliberate hardening vs. the old server, which caught ParseError
        // and yielded no decision at all (handlers.py:129-130).
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

// ── Daemon querying ───────────────────────────────────────────────────────────

/**
 * OPA's REST API serializes a Rego set two different ways depending on how
 * the rule was written - verified against a real opa run instance:
 *   - `decisions contains d if {...}` (new-style set rule) -> a plain JSON
 *     array of elements.
 *   - `decisions[decision] if {...}` (older partial-set-rule syntax, used
 *     throughout the real policies in agent-policies-server) -> a JSON
 *     OBJECT whose keys are each element's own JSON-encoded string and
 *     whose values are all `true`.
 * Both must be handled since the real bundles use the older syntax.
 */
function parseDecisionSet(rawResult) {
  if (Array.isArray(rawResult)) {
    return rawResult.filter((d) => d && typeof d === 'object').map((decision) => ({ kind: 'decision', ...decision }));
  }

  if (rawResult && typeof rawResult === 'object') {
    return Object.keys(rawResult)
      .map((key) => {
        try {
          return JSON.parse(key);
        } catch {
          return null;
        }
      })
      .filter((d) => d && typeof d === 'object')
      .map((decision) => ({ kind: 'decision', ...decision }));
  }

  return [];
}

async function queryDecisions(socketPath, bundleName, input) {
  const { status, body } = await requestOverSocket(
    socketPath,
    'POST',
    `/v1/data/${bundleName}/decisions`,
    { input },
    2000,
  );
  if (status !== 200) return [];
  try {
    const parsed = JSON.parse(body);
    return parseDecisionSet(parsed.result);
  } catch {
    return [];
  }
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
    for (const bundleName of bundles) {
      const results = await queryDecisions(socketPath, bundleName, doc);
      allResults.push(...results);
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
