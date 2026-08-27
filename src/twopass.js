'use strict';

// Implements the incomplete/require multi-pass evaluation protocol: a Rego
// decision can be {"action": "incomplete", "require": [{"kind": ..., ...}]}
// instead of a final allow/deny/ask, naming what external data it needs
// before it can decide (e.g. a package's PyPI age). This module queries the
// daemon, resolves any incomplete requests via a fixed set of resolvers, and
// re-queries once with the resolved data folded into input.

const { requestOverSocket } = require('./daemon');
const { resolvePypiMetadata } = require('./measurements/pypi');

const MAX_PASSES = 2;

/**
 * Closed registry: `kind` must be a name we recognize, not a value that
 * dispatches to arbitrary code. An unrecognized kind is a policy/client
 * version mismatch, not something to guess at - see resolveRequireEntries.
 */
const RESOLVERS = {
  pypi_metadata: async (entry) => resolvePypiMetadata(entry.package),
};

/**
 * OPA's REST API serializes a Rego set two different ways depending on how
 * the rule was written: `decisions contains d if {...}` as a plain JSON
 * array of elements, `decisions[decision] if {...}` (the older partial-set
 * syntax) as a JSON object whose keys are each element's own JSON-encoded
 * string. Both are handled since either can appear across different bundles.
 */
function parseDecisionSet(rawResult) {
  if (Array.isArray(rawResult)) {
    return rawResult.filter((d) => d && typeof d === 'object');
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
      .filter((d) => d && typeof d === 'object');
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

/** Stable stringify so two structurally-identical require entries with keys
 * in a different order still dedupe to the same cache key. */
function stableKey(entry) {
  const sortedKeys = Object.keys(entry).sort();
  return JSON.stringify(sortedKeys.map((k) => [k, entry[k]]));
}

/**
 * Resolve every distinct `require` entry across a set of incomplete
 * decisions. Returns { pypi_metadata: {...}, pypi_lookup_attempted: {...},
 * ...} - one package-keyed object per resolver kind that produced any
 * entries, matching what the Rego rules expect to find in `input`. Throws
 * UnknownRequireKindError if any entry names a kind with no registered
 * resolver, so the caller can fail safe rather than silently drop it.
 *
 * `resolvers` defaults to the real RESOLVERS registry; tests substitute
 * fixed responses so no live network call is needed to exercise the
 * dedup/merge/error-handling logic in this function.
 */
async function resolveRequireEntries(incompleteDecisions, resolvers = RESOLVERS) {
  const seen = new Set();
  const entries = [];
  for (const decision of incompleteDecisions) {
    for (const entry of decision.require || []) {
      const key = stableKey(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(entry);
    }
  }

  const resolvedByKind = {};
  const attemptedByKind = {};

  for (const entry of entries) {
    const resolver = resolvers[entry.kind];
    if (!resolver) {
      throw new UnknownRequireKindError(entry.kind);
    }

    resolvedByKind[entry.kind] ??= {};
    attemptedByKind[entry.kind] ??= {};

    const value = await resolver(entry);
    // Every resolver's entry shape has exactly one identifying key besides
    // `kind` today (package). If a future resolver needs a compound key,
    // this is the place to generalize - kept simple while there's one case.
    const identifyingKey = entry.package;
    attemptedByKind[entry.kind][identifyingKey] = true;
    if (value !== null && value !== undefined) {
      resolvedByKind[entry.kind][identifyingKey] = value;
    }
  }

  const merged = {};
  if (resolvedByKind.pypi_metadata) merged.pypi_metadata = resolvedByKind.pypi_metadata;
  if (attemptedByKind.pypi_metadata) merged.pypi_lookup_attempted = attemptedByKind.pypi_metadata;
  return merged;
}

class UnknownRequireKindError extends Error {
  constructor(kind) {
    super(`No resolver registered for require kind: ${kind}`);
    this.kind = kind;
  }
}

/**
 * Query `input` against every bundle, resolving one round of "incomplete"
 * requests if any bundle asks for one, capped at MAX_PASSES total queries so
 * a policy that keeps asking for the same thing can never hang the hook.
 * Returns the final list of decision objects (never includes "incomplete"
 * results - if pass 2 is still incomplete, that's treated as unresolvable
 * and dropped, same as an unknown require kind).
 *
 * Throws nothing: any failure (unreachable daemon, unknown require kind,
 * still-incomplete after the cap) degrades to an empty result list, letting
 * the caller fall back to default_policy_behavior exactly as if the daemon
 * were unreachable.
 */
async function queryWithMultiPass(socketPath, bundles, input, resolvers = RESOLVERS) {
  let currentInput = input;
  let allDecisions = [];

  for (let pass = 1; pass <= MAX_PASSES; pass += 1) {
    allDecisions = [];
    for (const bundleName of bundles) {
      const decisions = await queryDecisions(socketPath, bundleName, currentInput);
      allDecisions.push(...decisions);
    }

    const incomplete = allDecisions.filter((d) => d.action === 'incomplete');
    if (incomplete.length === 0) {
      return allDecisions;
    }

    if (pass === MAX_PASSES) {
      // A rule returned "incomplete" even after we already tried to satisfy
      // it once - either a policy bug or an unresolvable request. Drop the
      // incomplete markers rather than surface them as a decision; a
      // well-formed policy always has a non-incomplete fallback.
      return allDecisions.filter((d) => d.action !== 'incomplete');
    }

    let resolved;
    try {
      resolved = await resolveRequireEntries(incomplete, resolvers);
    } catch (err) {
      if (err instanceof UnknownRequireKindError) {
        return [];
      }
      throw err;
    }

    currentInput = { ...currentInput, ...resolved };
  }

  return allDecisions;
}

module.exports = { queryWithMultiPass, resolveRequireEntries, parseDecisionSet, UnknownRequireKindError };
