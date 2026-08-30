'use strict';

// Implements the incomplete/require multi-pass evaluation protocol: a Rego
// decision can be {"action": "incomplete", "require": [{"kind": ..., ...}]}
// instead of a final allow/deny/ask, naming what external data it needs
// before it can decide (e.g. a package's PyPI age). This module queries the
// daemon, resolves any incomplete requests via a fixed set of resolvers, and
// re-queries once with the resolved data folded into input.

const { requestOverSocket } = require('./daemon');
const { resolvePypiMetadata } = require('./measurements/pypi');
const { commentRatio } = require('./measurements/commentRatio');
const { commentOverlap } = require('./measurements/commentOverlap');
const { commentedCode } = require('./measurements/commentedCode');
const { legacyCode } = require('./measurements/legacyCode');
const { midCodeImport } = require('./measurements/midCodeImport');
const { license } = require('./measurements/license');

const MAX_PASSES = 2;

/**
 * Closed registry: `kind` must be a name we recognize, not a value that
 * dispatches to arbitrary code. An unrecognized kind is a policy/client
 * version mismatch, not something to guess at - see resolveRequireEntries.
 *
 * `keyedBy` names the require-entry field that identifies which of
 * possibly-several results of this kind a value belongs to (e.g.
 * "package" for pypi_metadata, since a command can name several packages).
 * Omitted for file-edit measurement kinds, which are 1-per-event and so
 * merge into input.measurements.<kind> as a flat value, not an object keyed
 * by anything - see resolveRequireEntries.
 */
const RESOLVERS = {
  pypi_metadata: { keyedBy: 'package', resolve: async (entry) => resolvePypiMetadata(entry.package) },
  comment_ratio: { resolve: async (_entry, input) => commentRatio(input) },
  comment_overlap: { resolve: async (_entry, input) => commentOverlap(input) },
  commented_code: { resolve: async (_entry, input) => commentedCode(input) },
  legacy_code: { resolve: async (_entry, input) => legacyCode(input) },
  mid_code_import: { resolve: async (_entry, input) => midCodeImport(input) },
  license: { resolve: async (_entry, input) => license(input) },
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

/**
 * Thrown when the request never reached a live daemon at all (socket
 * missing/refused, or timed out) - distinguishable from OPA itself
 * responding with a clean non-200 (a real answer, just not a 200), which
 * still means "no results" rather than "go spawn a daemon".
 */
class DaemonUnreachableError extends Error {
  constructor(cause) {
    super(`daemon unreachable: ${cause.message}`);
    this.cause = cause;
  }
}

async function queryRuleSet(socketPath, bundleName, ruleName, input) {
  let status, body;
  try {
    ({ status, body } = await requestOverSocket(
      socketPath,
      'POST',
      `/v1/data/${bundleName}/${ruleName}`,
      { input },
      2000,
    ));
  } catch (err) {
    throw new DaemonUnreachableError(err);
  }
  if (status !== 200) return [];
  try {
    const parsed = JSON.parse(body);
    return parseDecisionSet(parsed.result);
  } catch {
    return [];
  }
}

function queryDecisions(socketPath, bundleName, input) {
  return queryRuleSet(socketPath, bundleName, 'decisions', input);
}

/**
 * Query the `guidances` rule set - a separate, parallel channel from
 * `decisions` (see policies/universal/file_edit_guidance.rego and
 * policies/*.rego's plain `guidances[g] if {...}` rules): guidance results
 * never carry an "incomplete" action, so they don't participate in the
 * multi-pass resolve loop - they are queried once, after decisions have
 * settled, using whatever measurements/pypi_metadata that loop resolved.
 */
function queryGuidances(socketPath, bundleName, input) {
  return queryRuleSet(socketPath, bundleName, 'guidances', input);
}

/** Stable stringify so two structurally-identical require entries with keys
 * in a different order still dedupe to the same cache key. */
function stableKey(entry) {
  const sortedKeys = Object.keys(entry).sort();
  return JSON.stringify(sortedKeys.map((k) => [k, entry[k]]));
}

/**
 * Resolve every distinct `require` entry across a set of incomplete
 * decisions, given the input document those decisions were produced from
 * (measurement resolvers read structured_patch/file_path off it; pypi_metadata
 * ignores it and reads the entry itself). Returns an object to merge into
 * the next pass's input - `{pypi_metadata: {...}, pypi_lookup_attempted:
 * {...}, measurements: {comment_ratio: {...}, ...}}` - shaped per resolver:
 * a `keyedBy` resolver (pypi_metadata) produces a package-keyed object plus
 * a matching "_attempted" map, since one command can name several packages;
 * an unkeyed resolver (the file-edit measurements) produces a single flat
 * value under `measurements.<kind>` - there is exactly one file per event,
 * so there is nothing to key by, and a `null` result (measured, nothing to
 * report) is itself sufficient to stop the policy from asking again (see
 * rego_tests/universal/file_edit_guidance_test.rego's null-measurement
 * cases). Throws UnknownRequireKindError if any entry names a kind with no
 * registered resolver, so the caller can fail safe rather than silently
 * drop it.
 *
 * `resolvers` defaults to the real RESOLVERS registry; tests substitute
 * fixed responses so no live network call is needed to exercise the
 * dedup/merge/error-handling logic in this function.
 */
async function resolveRequireEntries(incompleteDecisions, input, resolvers = RESOLVERS) {
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

  const keyedResults = {};
  const keyedAttempted = {};
  const flatMeasurements = {};

  for (const entry of entries) {
    const resolver = resolvers[entry.kind];
    if (!resolver) {
      throw new UnknownRequireKindError(entry.kind);
    }

    const value = await resolver.resolve(entry, input);

    if (resolver.keyedBy) {
      const identifyingKey = entry[resolver.keyedBy];
      keyedResults[entry.kind] ??= {};
      keyedAttempted[entry.kind] ??= {};
      keyedAttempted[entry.kind][identifyingKey] = true;
      if (value !== null && value !== undefined) {
        keyedResults[entry.kind][identifyingKey] = value;
      }
    } else {
      flatMeasurements[entry.kind] = value;
    }
  }

  const merged = {};
  if (keyedResults.pypi_metadata) merged.pypi_metadata = keyedResults.pypi_metadata;
  if (keyedAttempted.pypi_metadata) merged.pypi_lookup_attempted = keyedAttempted.pypi_metadata;
  if (Object.keys(flatMeasurements).length > 0) merged.measurements = flatMeasurements;
  return merged;
}

class UnknownRequireKindError extends Error {
  constructor(kind) {
    super(`No resolver registered for require kind: ${kind}`);
    this.kind = kind;
  }
}

/**
 * Query `guidances` for every bundle using the given input, merging results
 * across bundles. Independent of the decisions multi-pass result - guidance
 * results never carry an "incomplete" action (see queryGuidances) - but
 * uses whatever measurements/pypi_metadata the decisions loop already
 * resolved, so a guidance rule reading the same input.measurements a
 * decision rule asked for sees the identical resolved value.
 */
async function collectGuidances(socketPath, bundles, input) {
  const allGuidances = [];
  for (const bundleName of bundles) {
    const guidances = await queryGuidances(socketPath, bundleName, input);
    allGuidances.push(...guidances);
  }
  return allGuidances;
}

/**
 * Query `input` against every bundle, resolving one round of "incomplete"
 * requests if any bundle asks for one, capped at MAX_PASSES total queries so
 * a policy that keeps asking for the same thing can never hang the hook.
 * Returns the final list of decision AND guidance objects (decisions never
 * include "incomplete" results - if pass 2 is still incomplete, that's
 * treated as unresolvable and dropped, same as an unknown require kind).
 * Decisions and guidances are tagged with `kind` so decide.js can tell them
 * apart after merging (matches src/decide.js's existing {kind: 'decision'}
 * / {kind: 'guidance'} contract).
 *
 * Throws nothing: any failure (unreachable daemon, unknown require kind,
 * still-incomplete after the cap) degrades to an empty result list, letting
 * the caller fall back to default_policy_behavior exactly as if the daemon
 * were unreachable. Guidances are skipped entirely in that case too, since
 * an unresolvable measurement means guidance rules reading it can't be
 * trusted either.
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
      const guidances = await collectGuidances(socketPath, bundles, currentInput);
      return [
        ...allDecisions.map((d) => ({ kind: 'decision', ...d })),
        ...guidances.map((g) => ({ kind: 'guidance', ...g })),
      ];
    }

    if (pass === MAX_PASSES) {
      // A rule returned "incomplete" even after we already tried to satisfy
      // it once - either a policy bug or an unresolvable request. Drop the
      // incomplete markers rather than surface them as a decision; a
      // well-formed policy always has a non-incomplete fallback. Guidances
      // still get queried - they don't participate in this resolve loop, so
      // a decision-side bug shouldn't suppress unrelated guidance output.
      const finalDecisions = allDecisions.filter((d) => d.action !== 'incomplete');
      const guidances = await collectGuidances(socketPath, bundles, currentInput);
      return [
        ...finalDecisions.map((d) => ({ kind: 'decision', ...d })),
        ...guidances.map((g) => ({ kind: 'guidance', ...g })),
      ];
    }

    let resolved;
    try {
      resolved = await resolveRequireEntries(incomplete, currentInput, resolvers);
    } catch (err) {
      if (err instanceof UnknownRequireKindError) {
        return [];
      }
      throw err;
    }

    currentInput = { ...currentInput, ...resolved };
  }

  return allDecisions.map((d) => ({ kind: 'decision', ...d }));
}

module.exports = {
  queryWithMultiPass,
  resolveRequireEntries,
  parseDecisionSet,
  UnknownRequireKindError,
  DaemonUnreachableError,
};
