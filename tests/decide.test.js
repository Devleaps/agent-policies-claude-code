'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mapToPreToolUseOutput, mapToPostToolUseOutput, findHighestPriorityDecision } = require('../src/decide');

test('no results returns bare continue output', () => {
  assert.deepEqual(mapToPreToolUseOutput([], null), { continue: true });
  assert.deepEqual(mapToPostToolUseOutput([]), { continue: true });
});

test('deny takes precedence over ask and allow', () => {
  const results = [
    { kind: 'decision', action: 'allow' },
    { kind: 'decision', action: 'ask', reason: 'confirm?' },
    { kind: 'decision', action: 'deny', reason: 'not allowed' },
  ];
  const decision = findHighestPriorityDecision(results.filter((r) => r.kind === 'decision'));
  assert.equal(decision.action, 'deny');

  const output = mapToPreToolUseOutput(results, null);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(output.hookSpecificOutput.permissionDecisionReason, 'not allowed');
  assert.equal(output.systemMessage, 'not allowed');
});

test('only reasons matching the final action are included', () => {
  const results = [
    { kind: 'decision', action: 'deny', reason: 'reason one' },
    { kind: 'decision', action: 'deny', reason: 'reason two' },
    { kind: 'decision', action: 'allow', reason: 'irrelevant allow reason' },
  ];
  const output = mapToPreToolUseOutput(results, null);
  assert.equal(output.systemMessage, 'reason one\nreason two');
});

test('guidance texts are appended after decision reasons', () => {
  const results = [
    { kind: 'decision', action: 'allow' },
    { kind: 'guidance', content: 'consider using trash instead' },
  ];
  const output = mapToPreToolUseOutput(results, null);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(output.systemMessage, 'consider using trash instead');
});

test('duplicate decisions with same action+reason are deduplicated', () => {
  const results = [
    { kind: 'decision', action: 'deny', reason: 'dup' },
    { kind: 'decision', action: 'deny', reason: 'dup' },
  ];
  const output = mapToPreToolUseOutput(results, null);
  assert.equal(output.systemMessage, 'dup');
});

test('duplicate guidance content is deduplicated', () => {
  const results = [
    { kind: 'guidance', content: 'same text' },
    { kind: 'guidance', content: 'same text' },
  ];
  const output = mapToPreToolUseOutput(results, null);
  assert.equal(output.systemMessage, 'same text');
});

test('falls back to default permission when no decision fired but guidance did', () => {
  const results = [{ kind: 'guidance', content: 'heads up' }];
  const output = mapToPreToolUseOutput(results, 'ask');
  assert.equal(output.hookSpecificOutput.permissionDecision, 'ask');
});

test('no default and no decision omits permissionDecision but keeps hookSpecificOutput', () => {
  const results = [{ kind: 'guidance', content: 'heads up' }];
  const output = mapToPreToolUseOutput(results, null);
  assert.equal(output.hookSpecificOutput.permissionDecision, undefined);
  assert.equal(output.hookSpecificOutput.permissionDecisionReason, 'heads up');
  assert.equal(output.systemMessage, 'heads up');
});

test('PostToolUse includes all reasons regardless of action, unlike PreToolUse', () => {
  const results = [
    { kind: 'decision', action: 'allow', reason: 'allow reason' },
    { kind: 'decision', action: 'deny', reason: 'deny reason' },
  ];
  const output = mapToPostToolUseOutput(results);
  assert.equal(output.hookSpecificOutput.additionalContext, 'allow reason\ndeny reason');
});

test('PostToolUse with decisions but no reasons and no guidance returns bare continue', () => {
  const results = [{ kind: 'decision', action: 'allow' }];
  const output = mapToPostToolUseOutput(results);
  assert.deepEqual(output, { continue: true });
});

test('a decision with no action (only flags) defaults to allow', () => {
  const results = [{ kind: 'decision', flags: [{ name: 'ran_tests', value: false }] }];
  const output = mapToPreToolUseOutput(results, null);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'allow');
});

test('a flags-only decision loses to an explicit deny from another decision', () => {
  const results = [
    { kind: 'decision', flags: [{ name: 'ran_tests', value: false }] },
    { kind: 'decision', action: 'deny', reason: 'not allowed' },
  ];
  const output = mapToPreToolUseOutput(results, null);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
});
