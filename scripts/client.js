#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const { parseCommand, ParseError } = require('../src/parser');
const { ensureDaemon, requestOverSocket, socketPathFor } = require('../src/daemon');
const { mapToPreToolUseOutput, mapToPostToolUseOutput } = require('../src/decide');

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
 * Build the Rego input document for one tool-use event. Returns null for
 * tools/events with no policy relevance (mirrors the server's evaluate_*_rules
 * functions each returning early for non-matching tool_name).
 */
async function buildInputDocument(payload) {
  const toolName = payload.tool_name;
  const toolInput = payload.tool_input || {};

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

    return {
      event: { tool_name: toolName },
      parsed: parsedCommandToRegoInput(parsed),
    };
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
    return { event: { tool_name: toolName, parameters: { host } } };
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
 * OPA's REST API serializes a Rego set (decisions contains d if {...}) as a
 * plain JSON array of its elements - verified against a real opa run
 * instance. (The CLI's `opa eval --format=values` output looks different,
 * printing sets as {"<json-string-key>": true}, but that's a CLI-only
 * pretty-printer, not what /v1/data returns.)
 */
function parseDecisionSet(rawResult) {
  if (!Array.isArray(rawResult)) return [];
  return rawResult
    .filter((d) => d && typeof d === 'object')
    .map((decision) => ({ kind: 'decision', ...decision }));
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

  let inputDoc;
  try {
    inputDoc = await buildInputDocument(payload);
  } catch (e) {
    process.stderr.write(`Failed to build policy input: ${e.message}\n`);
    process.exit(2);
  }

  if (inputDoc === null) {
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  }

  if (inputDoc.forcedDenyReason) {
    const results = [{ kind: 'decision', action: 'deny', reason: inputDoc.forcedDenyReason }];
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
  for (const bundleName of bundles) {
    const results = await queryDecisions(socketPath, bundleName, inputDoc);
    allResults.push(...results);
  }

  const output =
    hookEventName === 'PreToolUse'
      ? mapToPreToolUseOutput(allResults, defaultPolicyBehavior)
      : mapToPostToolUseOutput(allResults);

  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

main();
